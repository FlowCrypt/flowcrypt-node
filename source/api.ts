
import * as http from 'http';
import { Context } from './context';
import { IncomingMessage, ServerResponse } from 'http';

export class HttpAuthErr extends Error { }
export class HttpClientErr extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}
export class HttpNotFoundErr extends HttpClientErr {
  constructor(message = "Not found", public statusCode = 404) {
    super(message);
  }
}
export class HttpRedirect extends Error {
  constructor(public url: string, public statusCode = Status.FOUND) {
    super(`Http redirect ${statusCode}: ${url}`);
  }
}

export enum Status {
  OK = 200,
  CREATED = 201,
  FOUND = 302,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  CONFLICT = 409, // conflicts with key on record - request needs to be verified
  SERVER_ERROR = 500,
  NOT_IMPLEMENTED = 501,
}

export type RequestHandler<REQ, RES> = (parsedReqBody: REQ, req: IncomingMessage, res: ServerResponse) => Promise<RES>;
type Handlers<REQ, RES> = { [request: string]: RequestHandler<REQ, RES> };

export class Api<REQ, RES> {

  public server: http.Server;
  protected apiName: string;
  protected context: Context;
  protected maxRequestSizeMb = 0;
  protected maxRequestSizeBytes = 0;

  constructor(context: Context, apiName: string, protected handlers: Handlers<REQ, RES>, protected urlPrefix = '') {
    this.apiName = apiName;
    this.context = context;
    this.server = http.createServer((request, response) => {
      this.handleReq(request, response).then((r) => {
        response.end(r);
        try {
          this.log(request, response);
        } catch (e) {
          context.log.exception(e).catch(console.error);
        }
      }).catch((e) => {
        if (e instanceof HttpAuthErr) {
          response.statusCode = Status.UNAUTHORIZED;
          response.setHeader('WWW-Authenticate', `Basic realm="${this.apiName}"`);
          e.stack = undefined;
        } else if (e instanceof HttpClientErr) {
          response.statusCode = e.statusCode;
          e.stack = undefined;
        } else if (e instanceof HttpRedirect) {
          response.statusCode = e.statusCode;
          response.setHeader('Location', e.url);
          e.stack = undefined;
        } else {
          context.log.exception(e, `url:${request.method}:${request.url}`).catch(console.error);
          response.statusCode = Status.SERVER_ERROR;
        }
        if (!(e instanceof HttpRedirect)) {
          response.setHeader('content-type', 'application/json');
        }
        const formattedErr = this.fmtErr(e);
        response.end(formattedErr);
        try {
          this.log(request, response, formattedErr);
        } catch (e) {
          context.log.exception(e).catch(console.error);
        }
      });
    });
  }

  public listen = (port: number, host = '127.0.0.1', maxMb = 100) => new Promise<void>((resolve, reject) => {
    this.maxRequestSizeMb = maxMb;
    this.maxRequestSizeBytes = maxMb * 1024 * 1024;
    this.server.listen(port, host);
    this.server.on('listening', () => {
      const address = this.server.address();
      const msg = `${this.apiName} listening on ${typeof address === 'object' && address ? address.port : address}`;
      this.context.log.info(msg);
      resolve();
    })
  });

  public close = (): Promise<void> => new Promise((resolve, reject) => this.server.close((err: any) => err ? reject(err) : resolve()));

  protected log = (req: http.IncomingMessage, res: http.ServerResponse, errRes?: Buffer) => undefined as void;

  protected handleReq = async (req: IncomingMessage, res: ServerResponse): Promise<Buffer> => {
    const handler = this.chooseHandler(req);
    if (handler) {
      return this.fmtHandlerRes(await handler(this.parseReqBody(await this.collectReq(req), req), req, res), res);
    }
    if ((req.url === '/' || req.url === `${this.urlPrefix}/`) && (req.method === 'GET' || req.method === 'HEAD')) {
      res.setHeader('content-type', 'application/json');
      return this.fmtRes({ app_name: this.apiName });
    }
    if ((req.url === '/alive' || req.url === `${this.urlPrefix}/alive`) && (req.method === 'GET' || req.method === 'HEAD')) {
      res.setHeader('content-type', 'application/json');
      return this.fmtRes({ alive: true });
    }
    if ((req.url === '/health' || req.url === `${this.urlPrefix}/health`) && (req.method === 'GET' || req.method === 'HEAD')) {
      res.setHeader('content-type', 'application/json');
      if (!this.context.db) {
        return this.fmtRes({ error: { message: 'no db configured' } });
      }
      const start = Date.now();
      try {
        return this.fmtRes(await this.context.db.read(async query => {
          let [{ result }] = await query('SELECT 1+2 AS result;');
          let health = Number(result) === 3 ? 'ok' : 'error';
          return { health, db: { ms: (Date.now() - start) } };
        }));
      } catch (e) {
        res.statusCode = Status.SERVER_ERROR;
        return this.fmtRes({ health: 'down', error: String(e), db: { ms: (Date.now() - start) } });
      }
    }
    throw new HttpClientErr(`unknown path ${req.url}`);
  }

  protected chooseHandler = (req: IncomingMessage): RequestHandler<REQ, RES> | undefined => {
    return this.handlers[(req.url || '').replace('/', '')];
  }

  protected fmtErr = (e: any): Buffer => {
    return Buffer.from(JSON.stringify({
      error: {
        message: String(e).replace(/^Error: /, ''),
        stack: e && typeof e === 'object' ? e.stack || '' : ''
      }
    }));
  }

  protected fmtHandlerRes = (handlerRes: RES, serverRes: ServerResponse): Buffer => {
    serverRes.setHeader('content-type', 'application/json');
    return this.fmtRes(handlerRes);
  }

  protected fmtRes = (response: {}): Buffer => {
    return Buffer.from(JSON.stringify(response));
  }

  protected collectReq = (req: IncomingMessage): Promise<Buffer> => new Promise((resolve, reject) => {
    const body: Buffer[] = [];
    let byteLength = 0;
    req.on('data', (chunk: Buffer) => {
      byteLength += chunk.length;
      if (this.maxRequestSizeBytes && byteLength > this.maxRequestSizeBytes) {
        reject(new HttpClientErr(`Message over ${this.maxRequestSizeMb} MB`))
      } else {
        body.push(chunk);
      }
    });
    req.on('end', () => {
      try {
        resolve(Buffer.concat(body));
      } catch (e) {
        reject(e);
      }
    });
  })

  protected parseReqBody = (body: Buffer, req: IncomingMessage): REQ => {
    return JSON.parse(body.toString());
  }

}
