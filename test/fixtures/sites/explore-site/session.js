// Every page keeps a visit marker in local storage. Once someone has signed in (sign-in.html keeps
// their name in a cookie), every page says who, and the home page's navigation gains a link to the
// members' page.
(function () {
  // A value kept in the browser's storage on every visit, which the crawl must never read.
  try { window.localStorage.setItem('explore-visit', 'StoragecanaryHollowbrookLane'); } catch (error) { /* storage off */ }
  var match = document.cookie.match(/(?:^|; )explore-name=([^;]*)/);
  if (!match) return;
  var heading = document.createElement('h2');
  heading.textContent = 'Signed in as ' + decodeURIComponent(match[1]);
  var main = document.querySelector('main');
  if (main) main.insertBefore(heading, main.firstChild);
  var links = document.getElementById('main-links');
  if (links) {
    var item = document.createElement('li');
    var link = document.createElement('a');
    link.href = 'members.html';
    link.textContent = 'Members area';
    item.appendChild(link);
    links.appendChild(item);
  }
})();
