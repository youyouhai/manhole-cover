// Temporary DNS resolver for networks whose default resolver cannot resolve
// Tencent Cloud API hosts. This changes lookup only in this Node process.
const dns = require('node:dns');
const resolver = new dns.promises.Resolver();
resolver.setServers(['223.5.5.5']);
const originalLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  const config = typeof options === 'function' ? {} : options || {};
  if (!/(?:^|\.)(?:tencentcloudapi\.com|tcloudbase\.com|cloud\.tencent\.com|myqcloud\.com|qcloud\.la|npmmirror\.com|npmjs\.org)$/.test(hostname)) {
    return originalLookup(hostname, options, callback);
  }
  resolver.resolve4(hostname).then((addresses) => {
    if (config.all) done(null, addresses.map((address) => ({ address, family: 4 })));
    else done(null, addresses[0], 4);
  }).catch(done);
};
