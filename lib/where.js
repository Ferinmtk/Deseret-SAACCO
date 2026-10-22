// Where a request came from: a rough town (from Vercel's location headers) and the device (from the browser's user agent).
// The town is only a guide. Mobile data often shows as Nairobi wherever the person is.
const countries = new Intl.DisplayNames(['en'], { type: 'region' });

function place(req) {
  const h = name => { try { return decodeURIComponent(req.get(name) || ''); } catch { return ''; } };
  const city = h('x-vercel-ip-city'), code = h('x-vercel-ip-country');
  let country = '';
  try { country = code ? countries.of(code) : ''; } catch { country = code; }
  return [city, country].filter(Boolean).join(', ');
}

function device(req) {
  const ua = req.get('user-agent') || '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return browser && os ? `${browser} on ${os}` : browser || os;
}

// "Nairobi, Kenya · Chrome on Android" for people; staff records add the IP address.
function whereFrom(req, { ip = false } = {}) {
  return [place(req) || 'Unknown place', device(req) || 'unknown device', ip && req.ip].filter(Boolean).join(' · ');
}

module.exports = { whereFrom };
