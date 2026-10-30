// Keeps the page's name in local storage and shows it; loads the profile and the token on request.
const shown = (id) => document.querySelector(`[data-testid="${id}"]`);
const name = shown('profile-name').dataset.name;
localStorage.setItem('profile.name', name);
shown('profile-name').textContent = name;

document.querySelector('#profile').addEventListener('click', async () => {
  const profile = await (await fetch('/api/profile')).json();
  const token = await (await fetch('/api/token')).json();
  shown('profile-email').textContent = String(profile.email);
  shown('account-token').textContent = String(token.token);
  shown('profile-state').textContent = 'Profile loaded';
});
