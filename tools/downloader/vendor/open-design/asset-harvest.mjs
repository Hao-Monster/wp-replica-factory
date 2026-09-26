// Derived from nexu-io/open-design@1b47e60bd46641469fcd8b69c496c4e3a548bc28.
// Copyright (c) 2026 Jane (@xiaoerzhan / 小耳). MIT; see LICENSE.
// Modified: extracted importable functions; standalone CLI and browser discovery removed.
const FONT_EXT = /\.(woff2?|ttf|otf|eot)(?:$|[?#])/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)(?:$|[?#])/i;
const MEDIA_EXT = /\.(mp4|webm|m4v|mov|mp3|ogg|wav)(?:$|[?#])/i;
const WEBFONT_CSS = /use\.typekit\.net\/[a-z0-9]+\.css|fonts\.googleapis\.com\/css/i;

export function classify(url, resourceType, contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.startsWith("font/") || ct.includes("font-woff") || FONT_EXT.test(url)) return "font";
  if (ct.startsWith("image/") || resourceType === "image" || IMAGE_EXT.test(url)) return "image";
  if (ct.startsWith("video/") || ct.startsWith("audio/") || resourceType === "media" || MEDIA_EXT.test(url)) return "media";
  if (ct.includes("text/css") || resourceType === "stylesheet") return "stylesheet";
  return null;
}
