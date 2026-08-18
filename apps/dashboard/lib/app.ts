import packageInfo from '../package.json';
import env from './env';

const app = {
  version: packageInfo.version,
  name: 'Coreframe Relay',
  // No dedicated Relay logo asset exists yet (public/logo.png is still the
  // inherited BoxyHQ starter-kit image) — pointed at a local path so at
  // least the wrong external domain/brand reference is gone. Replace the
  // file, not this path, once real Relay logo art exists.
  logoUrl: '/logo.png',
  url: env.appUrl,
};

export default app;
