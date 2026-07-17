const WRAPPER_MARKER = "/* pi-mission-control workflow context */";

export function wrapWorkflowScript(
  script: string,
  promptPrefix: string,
): string {
  if (script.includes(WRAPPER_MARKER)) return script;
  const injection = `${WRAPPER_MARKER}\nagent = ((originalAgent) => (prompt, options) => originalAgent(${JSON.stringify(
    `${promptPrefix}\n\n`,
  )} + String(prompt), options))(agent);\n`;
  const directive =
    /^(\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*(?:["']use strict["'];?\s*)?)/;
  const prefixLength = directive.exec(script)?.[0].length ?? 0;
  return `${script.slice(0, prefixLength)}${injection}${script.slice(prefixLength)}`;
}
