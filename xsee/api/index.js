const { app } = require('../server/vercel-app');

module.exports = (req, res) => {
  const requestUrl = new URL(req.url, 'http://vercel.local');
  const apiPath = requestUrl.searchParams.get('path');
  if (!apiPath) return app(req, res);

  requestUrl.searchParams.delete('path');
  const query = requestUrl.searchParams.toString();
  req.url = `/api/${apiPath}${query ? `?${query}` : ''}`;
  return app(req, res);
};
