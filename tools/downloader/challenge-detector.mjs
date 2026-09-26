const compact = value => String(value || '').replace(/\s+/g,' ').trim().slice(0,240);
export function detectChallenge({url,status,headers={},title='',body='',pageRuntimeErrors=[],resources=[]}) {
  const text = `${title} ${body}`;
  const lower = text.toLowerCase();
  const signals=[];
  const hasPassword = /<input[^>]+type=["']?password/i.test(body);
  const hasCaptcha = (/data-sitekey|g-recaptcha|hcaptcha|class=["'][^"']*captcha/i.test(body) || /^(?:captcha|captcha verification|verify captcha)$/i.test(title.trim())) && /(?:verify|challenge|sitekey|captcha)/i.test(lower);
  const challengeTitle = /verify you are human|checking your browser|access denied|too many requests/i.test(title);
  const hasHuman = (challengeTitle || /id=["']?challenge|class=["'][^"']*challenge|data-captcha|cf-chl|awswaf/i.test(body)) && /verify you are human|checking your browser|bot verification|human verification/i.test(lower);
  const hasLogin = /sign[ -]?in|log[ -]?in|authenticate/i.test(title) || (hasPassword && /sign[ -]?in|log[ -]?in|username/i.test(lower));
  const hasMfa = /multi[- ]?factor|\bmfa\b|one[- ]?time[- ]?code|two[- ]?factor/i.test(title);
  const hasAccessDenied = status===403 || /access denied|forbidden/i.test(lower);
  const hasRate = status===429 || /too many requests|rate limit/i.test(lower);
  const awsRuntime = pageRuntimeErrors.some(e=>/AwsWafIntegration/i.test(e.detail||e.message||''));
  const awsResource = resources.some(r=>/awswaf|captcha/i.test(r.url||''));
  if (hasHuman || (awsRuntime && awsResource && (status===403 || /challenge|checking your browser/i.test(lower)))) { signals.push('challenge_document','challenge_runtime_or_resource'); return {detected:true,kind:'waf_bot_challenge',vendor:awsRuntime&&awsResource?'aws-waf':'unknown',confidence:'high',signals}; }
  if (hasCaptcha) { signals.push('captcha_dom_or_text'); return {detected:true,kind:'captcha',vendor:'unknown',confidence:'high',signals}; }
  if (hasMfa) { signals.push('mfa_text_or_input'); return {detected:true,kind:'mfa',vendor:'unknown',confidence:'high',signals}; }
  if (hasPassword) { signals.push('password_input'); return {detected:true,kind:'password',vendor:'unknown',confidence:'high',signals}; }
  if (hasLogin) { signals.push('login_form_or_text'); return {detected:true,kind:'login',vendor:'unknown',confidence:'medium',signals}; }
  if (hasRate) { signals.push('rate_limit_status_or_text'); return {detected:true,kind:'rate_limited',vendor:'unknown',confidence:'high',signals}; }
  if (hasAccessDenied) { signals.push('access_denied_status_or_text'); return {detected:true,kind:'access_denied',vendor:'unknown',confidence:'high',signals}; }
  return {detected:false,kind:null,vendor:null,confidence:'none',signals:[],summary:compact(text)};
}
