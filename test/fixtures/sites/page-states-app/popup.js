// Opens help.html as a popup when "Open help" is clicked, and shows whether the popup this page
// opened is still open, as the page itself sees it.
const popupState = document.querySelector('[data-testid="popup-state"]');
let popup = null;
document.getElementById('popup').addEventListener('click', () => { popup = window.open('/help.html', 'help', 'width=400,height=300'); });
setInterval(() => { if (popup !== null) popupState.textContent = popup.closed ? 'closed' : 'open'; }, 50);
