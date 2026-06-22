// ACERVIS: CORS Helper
export function setCors(res, methods = 'GET, POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-super-admin-secret, x-institution-token');
}

export function handlePreflight(req, res, methods = 'GET, POST, OPTIONS') {
  if (req.method === 'OPTIONS') {
    setCors(res, methods);
    return res.status(200).end();
  }
  setCors(res, methods);
}

export function error(res, code, message, status = 400) {
  return res.status(status).json({ error: message, code });
}
