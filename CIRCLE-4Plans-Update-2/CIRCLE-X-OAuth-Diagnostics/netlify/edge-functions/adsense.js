// AdSense uses a per-response nonce, as required by Google's strict-CSP guide.
// Only the public document is transformed; API, auth and payment routes bypass it.
export const publisherId = 'ca-pub-9785416280830190';
export const adsenseSrc = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${publisherId}`;

// Keep the supplied A8 destination, creative and impression URLs unchanged.
// This sits outside both application roots so login and X-screen re-renders
// cannot remove the banner or issue a second impression request.
export const affiliateMarkup = `<aside id="circle-affiliate-a8" aria-labelledby="circle-affiliate-a8-label" style="box-sizing:border-box;width:100%;padding:32px 16px;margin:24px auto 0;border-top:1px solid #deded8;text-align:center">
<p id="circle-affiliate-a8-label" style="margin:0 0 12px;color:#6b6b63;font-size:12px;letter-spacing:.12em">広告</p>
<div style="width:300px;max-width:100%;margin:0 auto">
<a href="https://px.a8.net/svt/ejp?a8mat=4BC9F4+DW480I+2PEO+C4LLD" rel="nofollow" aria-label="広告のリンクを開く" style="display:block">
<img border="0" width="300" height="250" alt="" src="https://www25.a8.net/svt/bgt?aid=260912560840&wid=005&eno=01&mid=s00000012624002037000&mc=1" style="display:block;width:100%;max-width:300px;height:auto"></a>
<img border="0" width="1" height="1" src="https://www18.a8.net/0.gif?a8mat=4BC9F4+DW480I+2PEO+C4LLD" alt="" style="display:block;width:1px;height:1px">
</div>
</aside>`;

export function addAffiliate(html) {
  if (/\bid\s*=\s*["']circle-affiliate-a8["']/i.test(html)) return html;
  if (!/<\/body\s*>/i.test(html)) throw new Error('Public document has no body');
  return html.replace(/<\/body\s*>/i, `${affiliateMarkup}</body>`);
}

export function createNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
}

export function contentSecurityPolicy(nonce) {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'unsafe-inline' 'unsafe-eval' 'strict-dynamic' https: http:`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data: https:",
    "connect-src 'self' https:",
    'frame-src https:',
    "media-src 'self' https: data: blob:",
    "worker-src 'self' blob:",
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function addAdsense(html, nonce) {
  if (!/<\/head\s*>/i.test(html)) throw new Error('Public document has no head');
  let membershipScripts = 0;
  let adsenseScripts = 0;
  // This is the repository-owned static document. Authorize its known entry
  // point, never arbitrary inline scripts or user-supplied HTML.
  const output = html.replace(/<script\b[^>]*>/gi, tag => {
    const src = tag.match(/\ssrc\s*=\s*["']([^"']*)["']/i)?.[1];
    if (src !== '/assets/membership.js' && src !== adsenseSrc) return tag;
    if (src === adsenseSrc) adsenseScripts++;
    else membershipScripts++;
    const clean = tag.replace(/\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    return clean.replace(/^<script\b/i, `<script nonce="${nonce}"`);
  });
  if (membershipScripts !== 1 || adsenseScripts > 1)
    throw new Error('Unexpected public script configuration');
  if (adsenseScripts === 1) return output;
  const tag = `<script nonce="${nonce}" async src="${adsenseSrc}" crossorigin="anonymous"></script>`;
  return output.replace(/<\/head\s*>/i, `${tag}</head>`);
}

export default async function adsense(request, context) {
  const path = new URL(request.url).pathname;
  if (request.method !== 'GET' || !['/', '/index.html'].includes(path)) return;
  const origin = await context.next();
  if (origin.status !== 200 || !origin.headers.get('content-type')?.toLowerCase().includes('text/html'))
    return origin;
  const nonce = createNonce();
  // Clone so an unexpected document can fall back to the unchanged application.
  let html;
  try { html = addAffiliate(addAdsense(await origin.clone().text(), nonce)); }
  catch { return origin; }
  const headers = new Headers(origin.headers);
  headers.set('Content-Security-Policy', contentSecurityPolicy(nonce));
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Netlify-CDN-Cache-Control', 'no-store');
  headers.set('CDN-Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.delete('ETag');
  headers.delete('Last-Modified');
  return new Response(html, {status: origin.status, statusText: origin.statusText, headers});
}

export const config = {
  path: ['/', '/index.html'],
  method: 'GET',
  onError: 'bypass',
};
