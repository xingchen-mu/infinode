import type { AgentCommand } from './types';

/** Built-in /commands of the assistant's input, each under its Chinese and English name. */
export const BUILTIN_COMMANDS = {
  /** Switch plan mode; with text after it, switch it on and send the text. */
  plan: ['计划', 'plan'],
  /** Condense the earlier conversation; text after it is what to keep in particular. */
  condense: ['整理', 'condense'],
  /** Start a new conversation. */
  new: ['新对话', 'new'],
} as const;

export type BuiltinCommand = keyof typeof BUILTIN_COMMANDS;

/** Where a saved command's prompt takes the text typed after it, as the help shows it in each language. */
export const COMMAND_SLOT = { zh: '{输入}', en: '{input}' } as const;

export const MAX_COMMANDS = 50;
export const MAX_COMMAND_PROMPT = 4000;
/** No spaces or slashes, at most 20 characters. */
export const COMMAND_NAME = /^[^\s/]{1,20}$/;

/** Which built-in a name is, in either language. */
export function builtinCommand(name: string): BuiltinCommand | undefined {
  const n = name.toLowerCase();
  return (Object.keys(BUILTIN_COMMANDS) as BuiltinCommand[]).find((k) => (BUILTIN_COMMANDS[k] as readonly string[]).includes(n));
}

/** "/name rest" → the name and the rest, or undefined when the text is not a command. */
export function parseCommand(text: string): { name: string; rest: string } | undefined {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1], rest: (m[2] ?? '').trim() } : undefined;
}

/** A saved command's prompt with the text after it: in place of {输入} / {input}, else on a line of its own. */
export function expandCommand(command: AgentCommand, rest: string): string {
  if (/\{(输入|input)\}/.test(command.prompt)) return command.prompt.replace(/\{(输入|input)\}/g, rest).trim();
  return rest ? `${command.prompt}\n\n${rest}` : command.prompt;
}
