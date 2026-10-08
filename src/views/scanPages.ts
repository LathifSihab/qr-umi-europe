import { LANGUAGES, isLang, type Lang } from "../config";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Supported languages in the visitor's Accept-Language order (highest q first). */
export function preferredLangs(acceptLanguage: string | null | undefined): Lang[] {
  if (!acceptLanguage) return [];
  const ranked = acceptLanguage
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { lang: tag.trim().split("-")[0].toLowerCase(), q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter((x) => x.q > 0 && !Number.isNaN(x.q))
    .sort((a, b) => b.q - a.q || a.i - b.i);
  const out: Lang[] = [];
  for (const { lang } of ranked) if (isLang(lang) && !out.includes(lang)) out.push(lang);
  return out;
}

/** Orders available languages: the visitor's best match first, then the default order. */
export function orderLangs(available: Lang[], acceptLanguage: string | null | undefined): Lang[] {
  const best = preferredLangs(acceptLanguage).find((l) => available.includes(l));
  const rest = LANGUAGES.map((l) => l.code).filter((l) => available.includes(l) && l !== best);
  return best ? [best, ...rest] : rest;
}

const TEXT: Record<Lang, { manual: string; choose: string; unavailable: string; unavailableBody: string; visit: string }> = {
  en: {
    manual: "Product manual",
    choose: "Choose your language",
    unavailable: "Manual not available",
    unavailableBody: "The manual for this product isn't available online right now. Visit our website for more information.",
    visit: "Go to umi-europe.com",
  },
  nl: {
    manual: "Handleiding",
    choose: "Kies je taal",
    unavailable: "Handleiding niet beschikbaar",
    unavailableBody: "De handleiding van dit product is op dit moment niet online beschikbaar. Kijk op onze website voor meer informatie.",
    visit: "Naar umi-europe.com",
  },
  fr: {
    manual: "Mode d’emploi",
    choose: "Choisissez votre langue",
    unavailable: "Mode d’emploi indisponible",
    unavailableBody: "Le mode d’emploi de ce produit n’est pas disponible en ligne pour le moment. Consultez notre site pour plus d’informations.",
    visit: "Aller sur umi-europe.com",
  },
  de: {
    manual: "Bedienungsanleitung",
    choose: "Sprache wählen",
    unavailable: "Anleitung nicht verfügbar",
    unavailableBody: "Die Anleitung für dieses Produkt ist derzeit nicht online verfügbar. Weitere Informationen finden Sie auf unserer Website.",
    visit: "Zu umi-europe.com",
  },
};

function uiLang(acceptLanguage: string | null | undefined): Lang {
  return preferredLangs(acceptLanguage)[0] ?? "en";
}

const CSS = `
:root{--deep:#08303D;--text:#213641;--blue:#0081BE;--blue-dark:#1F7491;--surface:#F3F2F2;--border:#D1D1D1;--muted:#919191}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--surface);color:var(--text);
font:400 17px/1.5 Figtree,system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:#fff;border-bottom:4px solid var(--deep);padding:14px 20px;display:flex;justify-content:center}
header img{display:block;height:48px;width:auto}
main{flex:1;width:100%;max-width:480px;margin:0 auto;padding:28px 20px 16px}
h1{margin:0;color:var(--deep);font-weight:600;font-size:24px;line-height:1.25;text-transform:uppercase;letter-spacing:.02em;overflow-wrap:anywhere}
.sub{margin:4px 0 24px;color:var(--muted)}
.label{margin:0 0 10px;font-weight:500}
ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}
a.btn{display:flex;align-items:center;justify-content:space-between;min-height:56px;padding:12px 18px;border-radius:3px;
border:2px solid var(--blue);background:#fff;color:var(--blue);font-weight:600;font-size:18px;text-decoration:none}
a.btn.primary{background:var(--blue);color:#fff}
a.btn:hover{border-color:var(--blue-dark);background:var(--blue-dark);color:#fff}
a.btn::after{content:"\\2192";font-size:20px}
a:focus-visible{outline:3px solid var(--blue);outline-offset:3px}
p.body{margin:0 0 24px}
footer{text-align:center;padding:20px;font-size:15px}
footer a{color:var(--blue)}
@media (prefers-reduced-motion:no-preference){a.btn{transition:background-color .15s,color .15s}}
`;

function layout(lang: Lang, title: string, body: string): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} – UMI Europe</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600&display=swap">
<style>${CSS}</style>
</head>
<body>
<header><a href="https://umi-europe.com"><img src="/assets/umi-logo.svg" alt="UMI Europe" width="92" height="48"></a></header>
<main>${body}</main>
<footer><a href="https://umi-europe.com">umi-europe.com</a></footer>
</body>
</html>`;
}

export function languagePickerPage(
  product: { code: string; name: string },
  langs: Lang[],
  acceptLanguage: string | null | undefined,
): string {
  const t = TEXT[langs[0] ?? uiLang(acceptLanguage)];
  const buttons = langs
    .map((code, i) => {
      const l = LANGUAGES.find((x) => x.code === code)!;
      return `<li><a class="btn${i === 0 ? " primary" : ""}" href="/f/${encodeURIComponent(product.code)}/${code}" hreflang="${code}" lang="${code}">${l.label}</a></li>`;
    })
    .join("");
  return layout(
    langs[0] ?? "en",
    product.name,
    `<h1>${escapeHtml(product.name)}</h1><p class="sub">${t.manual}</p><p class="label">${t.choose}</p><ul>${buttons}</ul>`,
  );
}

export function notAvailablePage(acceptLanguage: string | null | undefined): string {
  const lang = uiLang(acceptLanguage);
  const t = TEXT[lang];
  return layout(
    lang,
    t.unavailable,
    `<h1>${t.unavailable}</h1><p class="sub">UMI Europe</p><p class="body">${t.unavailableBody}</p><ul><li><a class="btn primary" href="https://umi-europe.com">${t.visit}</a></li></ul>`,
  );
}
