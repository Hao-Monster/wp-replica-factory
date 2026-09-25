// Derived from nexu-io/open-design@1b47e60bd46641469fcd8b69c496c4e3a548bc28.
// Copyright (c) 2026 Jane (@xiaoerzhan / 小耳). MIT; see LICENSE.
// Modified: exported the browser scroll sequence; bounded steps/time and dynamic
// height. Re-fetch, query-stripping paths and the standalone launcher removed.
export async function scrollThroughPage(page, args, deadline) {
  let steps=0, reachedEnd=false;
  for(let y=0; steps<args.maxScrollSteps && Date.now()<deadline; y+=args.scrollStep) {
    const total=await page.evaluate(()=>document.documentElement.scrollHeight);
    await page.evaluate(yy=>window.scrollTo(0,yy),y);
    await page.waitForTimeout(150);
    steps++;
    if(y>=total) { reachedEnd=true; break; }
  }
  if(!reachedEnd) throw new Error('scroll_budget_exhausted');
  await page.waitForTimeout(args.settleMs);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.waitForTimeout(150);
  return {steps,reachedEnd};
}
