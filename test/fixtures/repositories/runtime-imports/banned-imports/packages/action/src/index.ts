import connect from 'chrome-remote-interface';

export const openProtocol = () => connect({ port: 9222 });
