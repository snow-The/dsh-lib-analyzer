import type { IncomingMessage, ServerResponse } from 'node:http';
import { type AcpGraphStatus } from './acp-graph-contract.js';
/** 诊断用：契约状态 + 最近一次失败原因。 */
export declare function acpGraphDiagnostics(): {
    status: AcpGraphStatus;
    lastProblem: {
        detail: string;
        status: AcpGraphStatus;
    } | null;
};
/**
 * 一行人类可读的状态，用于工具输出。刻意区分"没装"与"装了但读不了"——
 * 图不可用时一律说"install dsh-session-handoff"会把人引向错误的方向。
 */
export declare function acpGraphStatusLine(): string;
/**
 * 契约是否【可读】——与数据量无关（"库健康但空"过去会被报成不可用，是误导）。
 * 注意这不是"docs 有内容"；那个问题由 acpDocsAvailable() 回答。
 */
export declare function acpGraphAvailable(): boolean;
export declare const name = "lib-analyzer";
export declare const inject: string[];
type Json = null | boolean | number | string | Json[] | {
    [k: string]: Json | undefined;
};
interface Tool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, Json>;
        required?: string[];
    };
    output: {
        schema: Json;
        render: (args: Json, value: Json) => {
            type: 'text';
            text: string;
        }[];
    };
    timeoutMs?: number;
    isConcurrencySafe?: () => boolean;
    presentCall?: (args: Json) => Json;
    execute: (args: Json, exec: {
        signal?: AbortSignal;
    }) => Promise<Json>;
}
/** Official web-server surface (host/webserver/src/index.ts:42-47, 166). */
interface WebServer {
    register: (route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }) => () => void;
}
/** The child context handed to the ctx.inject callback — here webServer is legal to read. */
interface InjectedCtx {
    webServer: WebServer;
    effect?: (fn: () => unknown, label?: string) => unknown;
}
interface Ctx {
    tools: {
        register: (tool: Tool) => void;
    };
    inject?: (deps: string[], cb: (ctx: InjectedCtx) => unknown) => unknown;
}
export declare function registerHttpRoutes(ctx: unknown, register: (kind: 'exact' | 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => void): void;
export declare function apply(ctx: Ctx): void;
export {};
