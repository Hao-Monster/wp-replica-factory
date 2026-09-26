// Derived from nexu-io/open-design@1b47e60bd46641469fcd8b69c496c4e3a548bc28.
// Copyright (c) 2026 Jane (@xiaoerzhan / 小耳). MIT; see LICENSE.
// Modified: extracted importable functions; standalone CLI and browser discovery removed.
export async function collectPage(page) {
  return page.evaluate(() => {
    const text = (node) => (node?.textContent || "").trim().replace(/\s+/g, " ");
    const links = Array.from(document.querySelectorAll("a[href]")).map((a) => ({
      href: a.href,
      text: text(a).slice(0, 120),
    }));
    const headings = Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 40).map((node) => ({
      tag: node.tagName.toLowerCase(),
      text: text(node).slice(0, 160),
    }));
    return {
      href: location.href,
      title: document.title || "",
      lang: document.documentElement.lang || "",
      metaDescription: document.querySelector("meta[name='description']")?.content || "",
      h1: Array.from(document.querySelectorAll("h1")).map((node) => text(node)).filter(Boolean).slice(0, 8),
      headings,
      scrollHeight: document.documentElement.scrollHeight,
      counts: {
        links: links.length,
        images: document.images.length,
        canvas: document.querySelectorAll("canvas").length,
        forms: document.forms.length,
        buttons: document.querySelectorAll("button,[role='button']").length,
      },
      links,
    };
  });
}
