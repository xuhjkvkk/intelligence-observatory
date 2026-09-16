import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const tags = new Set('svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath title desc linearGradient radialGradient stop clipPath mask pattern marker filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence animate animateTransform animateMotion mpath set style'.split(' '));
const unsafeCSS = /@import|@font-face|expression\s*\(|(?:https?:|data:|javascript:|file:|\/\/)|\\|<|>/i;
function localURLsOnly(value) {
  return ![...value.matchAll(/url\s*\(([^)]*)\)/gi)].some(m => !/^['"]?#[\w.-]+['"]?$/.test(m[1].trim()));
}

// Model output is untrusted. Restrict it to standalone SVG, then render in a
// scriptless opaque-origin iframe with its own no-network Content Security Policy.
export function inspectSVG(raw, challenge) {
  const signals = [];
  const match = raw.match(/<svg\b[\s\S]*?<\/svg\s*>/i);
  if (!match) return { svg: '', signals: ['没有找到完整的 SVG 图形'], valid: false };
  const fragment = match[0];
  if (fragment.length > 500_000) return { svg: '', signals: ['SVG 超过 500 KB 限制'], valid: false };
  if (/<!DOCTYPE|<!ENTITY/i.test(fragment)) return { svg: '', signals: ['不支持 XML 实体或文档声明'], valid: false };
  let malformed = false;
  let doc;
  try {
    doc = new DOMParser({ errorHandler: {
      warning: () => { malformed = true; }, error: () => { malformed = true; }, fatalError: () => { malformed = true; },
    } }).parseFromString(fragment, 'image/svg+xml');
  } catch { malformed = true; }
  if (malformed || !doc?.documentElement || doc.documentElement.localName !== 'svg') {
    return { svg: '', signals: ['SVG 不是有效的 XML'], valid: false };
  }
  let removed = false;
  const clean = node => {
    for (const child of Array.from(node.childNodes ?? [])) {
      if (child.nodeType === 1) {
        if (!tags.has(child.nodeName)) { node.removeChild(child); removed = true; continue; }
        clean(child);
      } else if (![3, 4].includes(child.nodeType)) node.removeChild(child);
    }
    if (!node.attributes) return;
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase(), value = attr.value;
      const namespace = name === 'xmlns' || name === 'xmlns:xlink';
      if (/^on/.test(name) || name === 'src' || name === 'xml:base' || name === 'target' || name === 'tabindex' ||
          ((name === 'href' || name.endsWith(':href')) && !/^#[\w.-]+$/.test(value)) ||
          (!namespace && /(?:javascript:|https?:|data:|file:|\/\/)/i.test(value)) ||
          !localURLsOnly(value) || (name === 'style' && unsafeCSS.test(value)) ||
          (name === 'attributename' && /href|src|^on|xml:|style/i.test(value))) {
        node.removeAttribute(attr.name); removed = true;
      }
    }
    if (node.nodeName === 'style' && (unsafeCSS.test(node.textContent) || !localURLsOnly(node.textContent))) {
      node.parentNode?.removeChild(node); removed = true;
    }
  };
  clean(doc.documentElement);
  doc.documentElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const svg = new XMLSerializer().serializeToString(doc.documentElement);
  if (removed) signals.push('输出包含不支持的脚本、外链或内容，已移除');
  if (!/<(?:animate|animateTransform|animateMotion)\b|@keyframes\b/i.test(svg)) signals.push('未检测到 SVG 或 CSS 动画');
  if (challenge && !svg.includes(challenge)) signals.push('未遵循本次随机验证标记');
  return { svg, signals, valid: signals.length === 0 };
}
