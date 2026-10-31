// Shows the session cookie on the page, so a control check can prove a leak scan finds it there.
document.querySelector('[data-testid="session-shown"]').textContent = document.cookie;
