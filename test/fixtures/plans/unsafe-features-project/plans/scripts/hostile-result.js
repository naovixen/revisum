(received) => {
  // Returns, throws or hangs as the plan asks, so a test can show how each kind of result fails.
  switch (received.kind) {
    case 'sized': return { shape: 'sized', padding: 'x'.repeat(received.amount) };
    case 'nested': {
      let value = 'bottom';
      for (let level = 0; level < received.amount; level += 1) value = [value];
      return { shape: 'nested', value };
    }
    case 'cyclic': {
      const value = { shape: 'cyclic' };
      value.self = value;
      return value;
    }
    case 'undefined': return undefined;
    case 'function': return () => 'not data';
    case 'throws': throw new Error('the hostile script threw');
    case 'rejects': return Promise.reject(new Error('the hostile script rejected'));
    case 'never-settles': return new Promise(() => {});
    default: return { shape: 'plain' };
  }
}
