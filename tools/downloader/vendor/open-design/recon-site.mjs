// Derived from nexu-io/open-design@1b47e60bd46641469fcd8b69c496c4e3a548bc28.
// Copyright (c) 2026 Jane (@xiaoerzhan / 小耳). MIT; see LICENSE.
// Modified: extracted importable functions; standalone CLI and browser discovery removed.
export async function collectSignals(page) {
  return page.evaluate(() => {
    const bySelector = (selector) => Array.from(document.querySelectorAll(selector));
    const text = (node) => (node?.textContent || "").trim().replace(/\s+/g, " ");
    const win = window;
    const scripts = bySelector("script[src]").map((s) => s.src);
    const stylesheets = bySelector("link[rel='stylesheet']").map((s) => s.href);
    const headings = bySelector("h1,h2,h3").slice(0, 60).map((h) => ({
      tag: h.tagName.toLowerCase(),
      text: text(h).slice(0, 160),
    }));
    const sections = bySelector("header,nav,main,section,article,aside,footer").slice(0, 80).map((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        tag: node.tagName.toLowerCase(),
        id: node.id || "",
        className: String(node.className || "").slice(0, 160),
        text: text(node).slice(0, 240),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        style: {
          display: style.display,
          position: style.position,
          backgroundColor: style.backgroundColor,
          color: style.color,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
        },
      };
    });
    const cssVariables = Array.from(document.styleSheets).flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules || []);
      } catch {
        return [];
      }
    }).flatMap((rule) => {
      const style = rule.style;
      if (!style) return [];
      return Array.from(style)
        .filter((name) => name.startsWith("--"))
        .map((name) => [name, style.getPropertyValue(name).trim()]);
    }).slice(0, 200);
    const images = bySelector("img").slice(0, 120).map((img) => ({
      src: img.currentSrc || img.src || img.getAttribute("data-src") || "",
      srcset: img.srcset || img.getAttribute("data-srcset") || "",
      alt: img.alt || "",
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0,
    }));
    // @font-face 规则原文 + 解析出的 src url——复刻必须自托管这些真字体，
    // 禁止用系统字体近似(见 SKILL.md 保真门槛)。
    const fontFaces = Array.from(document.styleSheets).flatMap((sheet) => {
      let rules;
      try {
        rules = Array.from(sheet.cssRules || []);
      } catch {
        return [];
      }
      return rules
        .filter((rule) => rule instanceof CSSFontFaceRule)
        .map((rule) => {
          const src = rule.style.getPropertyValue("src");
          const srcUrls = Array.from(src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)).map((m) => m[1]);
          return {
            family: rule.style.getPropertyValue("font-family").replace(/['"]/g, "").trim(),
            weight: rule.style.getPropertyValue("font-weight") || "",
            style: rule.style.getPropertyValue("font-style") || "",
            srcUrls,
            cssText: rule.cssText,
            sheetHref: sheet.href || location.href,
          };
        });
    }).slice(0, 60);
    // 页面实际加载过的资源 URL(懒加载图、CSS 背景图、字体二进制都在这)——
    // 这是"真实用到的资产"全集，asset-harvest 以此下载。
    const resourceEntries = performance.getEntriesByType("resource");
    const resources = { images: [], fonts: [], media: [] };
    for (const entry of resourceEntries) {
      const url = entry.name;
      if (/\.(woff2?|ttf|otf|eot)(?:$|[?#])/i.test(url)) resources.fonts.push(url);
      else if (entry.initiatorType === "img" || /\.(png|jpe?g|gif|webp|avif|svg|ico)(?:$|[?#])/i.test(url)) resources.images.push(url);
      else if (/\.(mp4|webm|m4v|mp3|ogg)(?:$|[?#])/i.test(url)) resources.media.push(url);
    }
    resources.images = Array.from(new Set(resources.images)).slice(0, 300);
    resources.fonts = Array.from(new Set(resources.fonts)).slice(0, 60);
    resources.media = Array.from(new Set(resources.media)).slice(0, 40);
    // 关键区块的精确取色——复刻时颜色必须照抄这里的值，不许目测。
    const paletteOf = (node) => {
      if (!node) return null;
      const style = getComputedStyle(node);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderColor: style.borderTopColor,
        fontFamily: style.fontFamily,
        backgroundImage: style.backgroundImage !== "none" ? style.backgroundImage.slice(0, 300) : "",
      };
    };
    const palette = {
      body: paletteOf(document.body),
      header: paletteOf(document.querySelector("header")),
      nav: paletteOf(document.querySelector("nav")),
      main: paletteOf(document.querySelector("main")),
      footer: paletteOf(document.querySelector("footer")),
      buttons: bySelector("button,[role='button'],a[class*='btn' i],a[class*='button' i]")
        .slice(0, 12)
        .map((node) => ({ text: text(node).slice(0, 40), ...paletteOf(node) })),
    };
    // 滚动体感信号——复刻必须还原原站的滚动手感(平滑滚动库/snap/sticky)，
    // 配合 frameworks 里的 lenis/gsap 检测一起读。
    const motion = (() => {
      let scrollSnapRules = 0;
      let smoothScrollRules = 0;
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try {
          rules = Array.from(sheet.cssRules || []);
        } catch {
          continue;
        }
        for (const rule of rules) {
          const ruleText = rule.cssText || "";
          if (ruleText.includes("scroll-snap")) scrollSnapRules += 1;
          if (ruleText.includes("scroll-behavior") && ruleText.includes("smooth")) smoothScrollRules += 1;
        }
      }
      const stickyOrFixedCount = bySelector("header,nav,aside,section,div")
        .slice(0, 500)
        .filter((el) => {
          const position = getComputedStyle(el).position;
          return position === "sticky" || position === "fixed";
        }).length;
      return {
        htmlScrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        scrollSnapRules,
        smoothScrollRules,
        stickyOrFixedCount,
      };
    })();
    // :root 自定义属性的"计算后"值(声明值可能是 var() 链)。
    const rootStyle = getComputedStyle(document.documentElement);
    const rootVariables = cssVariables
      .map(([name]) => [name, rootStyle.getPropertyValue(name).trim()])
      .filter(([, value]) => value)
      .slice(0, 200);
    const canvases = bySelector("canvas").map((canvas) => ({
      width: canvas.width,
      height: canvas.height,
      cssWidth: canvas.getBoundingClientRect().width,
      cssHeight: canvas.getBoundingClientRect().height,
    }));
    return {
      href: location.href,
      title: document.title,
      lang: document.documentElement.lang || "",
      bodyTextChars: (document.body?.innerText || "").length,
      scrollHeight: document.documentElement.scrollHeight,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      h1: bySelector("h1").map((h) => text(h)).filter(Boolean).slice(0, 10),
      headings,
      metaDescription: document.querySelector("meta[name='description']")?.content || "",
      counts: {
        links: bySelector("a[href]").length,
        images: bySelector("img").length,
        video: bySelector("video").length,
        canvas: bySelector("canvas").length,
        sections: sections.length,
        forms: bySelector("form").length,
        buttons: bySelector("button").length,
        inputs: bySelector("input,textarea,select").length,
        interactive: bySelector("a[href],button,input,textarea,select,summary,[role='button'],[tabindex]").length,
        scripts: scripts.length,
        stylesheets: stylesheets.length,
      },
      frameworks: {
        react: Boolean(win.__REACT_DEVTOOLS_GLOBAL_HOOK__) || Boolean(document.querySelector("#__next,[data-reactroot],[data-reactid]")),
        next: Boolean(document.querySelector("#__next")) || scripts.some((src) => src.includes("/_next/")),
        vue: Boolean(win.__VUE__) || Boolean(document.querySelector("[data-v-app]")),
        nuxt: Boolean(win.__NUXT__) || scripts.some((src) => src.includes("/_nuxt/")),
        svelte: Boolean(document.querySelector("[data-svelte-h]")),
        astro: Boolean(document.querySelector("[data-astro-cid]")) || scripts.some((src) => src.includes("astro")),
        three: Boolean(win.THREE) || scripts.some((src) => /three(\.module)?(\.min)?\.js/i.test(src)),
        gsap: Boolean(win.gsap) || scripts.some((src) => src.toLowerCase().includes("gsap")),
        lenis: Boolean(win.Lenis) || scripts.some((src) => src.toLowerCase().includes("lenis")),
      },
      scripts: scripts.slice(0, 120),
      stylesheets: stylesheets.slice(0, 80),
      sections,
      cssVariables,
      rootVariables,
      palette,
      motion,
      fonts: Array.from(document.fonts || []).map((font) => font.family).filter(Boolean).slice(0, 40),
      fontFaces,
      resources,
      images,
      canvases,
    };
  });
}
