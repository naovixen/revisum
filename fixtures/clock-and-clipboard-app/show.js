// Writes text into the element with the given test id.
const show = (testId, text) => {
  document.querySelector(`[data-testid="${testId}"]`).textContent = text;
};
