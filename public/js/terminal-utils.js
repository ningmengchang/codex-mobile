// Placeholders must be standalone shell arguments, never interpolated inside quotes.
export function templateParameters(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4096) throw new Error('命令不能为空，且最多 4096 字符。');
  let quote = '', escaped = false;
  const names = [];
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (command.slice(i, i + 2) === '{{') {
      const match = /^\{\{([a-zA-Z][a-zA-Z0-9_]{0,31})\}\}/.exec(command.slice(i));
      if (!match || quote || escaped || (i && !/\s/.test(command[i - 1])) ||
          (i + match[0].length < command.length && !/\s/.test(command[i + match[0].length]))) {
        throw new Error('参数请使用独立的 {{name}}，不要放在引号、路径或其他字符中。');
      }
      names.push(match[1]); i += match[0].length - 1; continue;
    }
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; }
    else if (char === "'" || char === '"' || char === '`') quote = char;
  }
  if (names.length > 20) throw new Error('参数最多 20 个。');
  if (names.length && /[\\\n\r"'`$<>(){}]/.test(command.replace(/\{\{[a-zA-Z][a-zA-Z0-9_]{0,31}\}\}/g, 'ARG'))) {
    throw new Error('参数化操作只支持简单命令或管道，不支持引号、重定向、变量展开和多行脚本。');
  }
  return [...new Set(names)];
}

export function expandTemplate(command, values) {
  const names = templateParameters(command);
  for (const name of names) if (typeof values[name] !== 'string' || values[name].length > 1024 || /[\x00-\x1f\x7f]/.test(values[name])) throw new Error(`参数 ${name} 无效。`);
  return command.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]{0,31})\}\}/g, (_, key) => "'" + values[key].replaceAll("'", "'\\''") + "'");
}

export function redactTerminalText(text) {
  return text.replace(/\b(sk-[\w-]{12,}|Bearer\s+[A-Za-z0-9._~+/-]{12,})/gi, '[已隐藏凭据]')
    .replace(/((?:[\w-]*(?:token|password|passwd|secret|api[_-]?key)[\w-]*)\s*[=:]\s*)([^\s]+)/gi, '$1[已隐藏]');
}
