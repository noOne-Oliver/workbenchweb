/**
 * 极小的 glob 匹配器：阶段闸门只需要「这个路径在不在允许的边界内」。
 * 支持 ** / * / ?；不带通配符的字符串按字面量比较。
 * 自己写而不是引依赖：边界判定是要被测、被审的代码，不该藏在别人的包里。
 */
export function globToRegExp(glob) {
  const s = String(glob || "").replace(/^\.\//, "");
  let out = "^";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "*") {
      if (s[i + 1] === "*") {
        i++;
        if (s[i + 1] === "/") { i++; out += "(?:.*/)?"; }
        else out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\.^$+{}()|[]".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  out += "$";
  return new RegExp(out);
}

/** 空边界 = 不限制。模板里每个阶段都会写明边界，空值只给「合并」这种合法的全局阶段用。 */
export function matchesAny(path, globs) {
  if (!globs || !globs.length) return true;
  const p = String(path || "");
  return globs.some((g) => globToRegExp(g).test(p));
}

/** 把越界与允许范围分开放：越界是要给人看的（他要知道「本来该改哪」）。 */
export function checkScope(paths, allowedGlobs) {
  const outside = [];
  for (const p of paths || []) {
    if (!matchesAny(p, allowedGlobs)) outside.push(p);
  }
  return { ok: outside.length === 0, outside, allowed: (allowedGlobs || []).slice() };
}