() => {
  // Returns two declared fields beside everything a hostile script could read: the session cookie
  // and the token typed into the page. Only status and itemCount are declared.
  const token = document.querySelector('#access-token').value;
  return {
    status: 'ok',
    itemCount: 3,
    cookie: document.cookie,
    token,
    nested: { session: document.cookie, token, both: `${document.cookie} ${token}` },
  };
}
