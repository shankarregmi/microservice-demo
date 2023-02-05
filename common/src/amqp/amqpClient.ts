import amqp from 'amqplib';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

/** Types */
import {
  IAMQPRPCHandlers,
  IAMQPRPCPayload,
  IMessageBrokerRepository,
} from '../types/IMessageBrokerRepository';

export class AMQPCLient implements IMessageBrokerRepository {
  private _connection!: amqp.Connection;
  private _channel!: amqp.Channel;
  private _replyToQueue!: string;

  private _handlerMappings = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: any) => void;
    }
  >();

  public async initialize(): Promise<void> {
    if (this._connection && this._channel)
      throw new Error('AMQP connection already initialized');

    this._connection = await amqp.connect(await this._buildConnectionString());

    this._connection.on('error', this._handleConnectionError.bind(this));
    this._connection.on('close', this._handleConnectionClose.bind(this));
    this._channel = await this._connection.createChannel();
  }

  public async registerRPCHandlers({
    rpcQueue,
    rpcHandlers,
  }: {
    rpcQueue: string;
    rpcHandlers: IAMQPRPCHandlers;
  }): Promise<void> {
    if (!this._channel) throw new Error('AMQP channel not initialized');

    await this._channel.assertQueue(rpcQueue, {
      durable: true,
    }); /** @todo make it configurable */

    await this._channel.prefetch(5);
    (async () => {
      await this._channel.consume(
        rpcQueue,
        async (message: amqp.ConsumeMessage | null) => {
          if (!message) return;

          const { content, properties } = message;

          const { correlationId, replyTo } = properties;

          const { type, data } = JSON.parse(content.toString());

          if (!rpcHandlers[type]) {
            console.error(`RPC Call ${type} not registered`);
            this._channel.sendToQueue(
              replyTo,
              Buffer.from(
                JSON.stringify({
                  error: 'RPC Call not registered',
                })
              ),
              {
                correlationId,
              }
            );
            return;
          }

          try {
            const result = await rpcHandlers[type](data);

            this._channel.sendToQueue(
              replyTo,
              Buffer.from(JSON.stringify(result)),
              {
                correlationId,
              }
            );

            this._channel.ack(message);
          } catch (err) {
            const serializedError = {
              error: 'Unknown Error',
            };
            if (err instanceof Error) {
              serializedError.error = err.message;
            }

            this._channel.sendToQueue(
              replyTo,
              Buffer.from(JSON.stringify(serializedError)),
              {
                correlationId,
              }
            );

            this._channel.ack(message);
          }
        }
      );
    })().catch((err) => {
      console.error(`Error consuming Message from Queue ${rpcQueue}`, err);
    });
  }

  public async executeRPC({
    rpcQueue,
    payload,
  }: {
    rpcQueue: string;
    payload: IAMQPRPCPayload;
  }): Promise<unknown> {
    if (!this._channel) throw new Error('AMQP channel not initialized');

    if (!this._replyToQueue) {
      await this._registerCallbackQueue();
    }

    return new Promise((resolve, reject) => {
      const correlationId = uuidv4();

      this._handlerMappings.set(correlationId, { resolve, reject });

      this._channel.sendToQueue(
        rpcQueue,
        Buffer.from(JSON.stringify(payload)),
        {
          correlationId,
          replyTo: this._replyToQueue,
        }
      );
    });
  }

  /** Build connection string either from secret file mounted or env variables */
  private async _buildConnectionString(): Promise<string> {
    if (process.env.AMQP_CONNECTION_STRING) {
      return process.env.AMQP_CONNECTION_STRING;
    } else if (process.env.AMQP_SECRET_PATH) {
      try {
        const secretFile = await fs.promises.readFile(
          process.env.AMQP_SECRET_PATH,
          'utf8'
        );

        return secretFile.trim();
      } catch (error) {
        console.error(`Error reading AMQP secret file: ${error}`);
        throw error;
      }
    } else if (
      process.env.AMQP_USERNAME &&
      process.env.AMQP_PASSWORD &&
      process.env.AMQP_HOST &&
      process.env.AMQP_PORT
    ) {
      return `amqp://${process.env.AMQP_USERNAME}:${process.env.AMQP_PASSWORD}@${process.env.AMQP_HOST}:${process.env.AMQP_PORT}`;
    } else {
      throw new Error(
        'Insufficient AMQP credentials provided. Please check the environment variables.'
      );
    }
  }

  /**
   * @todo: Implement Reconnect logic
   */
  private _handleConnectionError(error: Error): void {
    console.error(`AMQP connection error: ${error}`);
  }

  private _handleConnectionClose(): void {
    console.error('AMQP connection closed');
  }

  private async _registerCallbackQueue(): Promise<void> {
    const replyQueueName = `rpc-reply-${uuidv4()}`;

    this._replyToQueue = (
      await this._channel.assertQueue(replyQueueName, {
        autoDelete: true,
        durable: false,
        messageTtl: 10000,
      })
    ).queue;

    (async () => {
      await this._channel.consume(
        this._replyToQueue,
        async (message: amqp.ConsumeMessage | null) => {
          if (message?.properties?.correlationId) {
            const correlationId = message.properties.correlationId;

            const rpcHandler = this._handlerMappings.get(correlationId);

            const rpcResponse = JSON.parse(message.content.toString());

            if (rpcResponse?.error) {
              rpcHandler?.reject(rpcResponse.error);
            } else {
              rpcHandler?.resolve(rpcResponse);
            }
          }
        },
        { noAck: true }
      );
    })().catch((err) => {
      console.error(
        `Error consuming Message from Queue ${this._replyToQueue}`,
        err
      );
    });
  }
}
