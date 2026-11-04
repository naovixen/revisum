/// <reference lib="dom" />
// The page functions that find a locator's elements. Like every function in in-page.ts, each is sent
// with toString(), so it must be self-contained.
//
// A person sees what is drawn in a shadow root like any other content, so these search open shadow
// roots, nested ones too. Finding one takes a look at every element of the tree above it, as no
// selector finds a host: each function holds its own short walk, a list of roots that grows as it is
// read. A selector matches within one root, as everywhere in a browser. Closed roots and XPath cannot
// be searched this way (see not-found in docs/errors.md). A template's content belongs to no tree, so
// it is never searched. A form's named inputs hide what it inherits, as in-page.ts says, so what may be
// a form is read through the prototypes. A form cannot host a shadow root, so a shadowRoot its input
// hides only adds an input to search, which holds nothing.

// Elements labelled exactly `label`: label[for], a wrapping label, aria-label or aria-labelledby.
export function findByLabel(label: string): Element[] {
  const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();
  const wanted = normalise(label);
  const found = new Set<Element>();
  const roots: (Document | ShadowRoot)[] = [document];
  for (const root of roots) {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.shadowRoot !== null) {
        roots.push(element.shadowRoot);
      }
    }
    for (const labelElement of Array.from(root.querySelectorAll("label"))) {
      if (labelElement.control !== null && normalise(labelElement.textContent) === wanted) {
        found.add(labelElement.control);
      }
    }
    for (const element of Array.from(root.querySelectorAll("[aria-label]"))) {
      if (normalise(Element.prototype.getAttribute.call(element, "aria-label") ?? "") === wanted) {
        found.add(element);
      }
    }
    for (const element of Array.from(root.querySelectorAll("[aria-labelledby]"))) {
      // An id names an element in the same root. Only the browser's element reference can reach out
      // of a root, into a root around it.
      const references = (element as Element & { ariaLabelledByElements?: readonly Element[] | null }).ariaLabelledByElements ?? [];
      const ids = (Element.prototype.getAttribute.call(element, "aria-labelledby") ?? "").split(/\s+/);
      const texts = references.length > 0
        ? references.map((reference) => Reflect.get(Node.prototype, "textContent", reference) as string)
        : ids.map((id) => {
            const labelledBy = root.getElementById(id);
            return labelledBy === null ? "" : (Reflect.get(Node.prototype, "textContent", labelledBy) as string);
          });
      if (normalise(texts.join(" ")) === wanted) {
        found.add(element);
      }
    }
  }
  return Array.from(found);
}

// The deepest elements whose rendered text is exactly `text`.
export function findByText(text: string): Element[] {
  const normalise = (value: string): string => value.replace(/\s+/g, " ").trim();
  const parentOf = (node: Element): Element | null => {
    const slot = Reflect.get(Element.prototype, "assignedSlot", node);
    if (slot !== null) {
      return slot;
    }
    const parent = Reflect.get(Node.prototype, "parentElement", node);
    if (parent !== null) {
      return parent;
    }
    const root = Node.prototype.getRootNode.call(node);
    return root instanceof ShadowRoot ? root.host : null;
  };
  const wanted = normalise(text);
  const matches: Element[] = [];
  const scopes: (HTMLElement | ShadowRoot)[] = [document.body];
  for (const scope of scopes) {
    for (const element of Array.from(scope.querySelectorAll("*"))) {
      if (element.shadowRoot !== null) {
        scopes.push(element.shadowRoot);
      }
      const isContent = !["SCRIPT", "STYLE", "TEMPLATE"].includes(element.tagName);
      // An SVG element has no innerText.
      const text = element instanceof HTMLElement ? Reflect.get(HTMLElement.prototype, "innerText", element) : "";
      if (isContent && normalise(text) === wanted) {
        matches.push(element);
      }
    }
  }
  const aroundAMatch = new Set<Element>();
  for (const match of matches) {
    for (let node = parentOf(match); node !== null; node = parentOf(node)) {
      aroundAMatch.add(node);
    }
  }
  return matches.filter((element) => !aroundAMatch.has(element));
}

// Elements whose `attribute` is exactly `testId`. Every element is compared by string equality, so
// no selector is ever built from plan text and selector syntax in a test id matches only itself.
export function findByTestId(testId: string, attribute: string): Element[] {
  const found: Element[] = [];
  const roots: (Document | ShadowRoot)[] = [document];
  for (const root of roots) {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.shadowRoot !== null) {
        roots.push(element.shadowRoot);
      }
      if (Element.prototype.getAttribute.call(element, attribute) === testId) {
        found.push(element);
      }
    }
  }
  return found;
}

// The given elements in document order, for picking one by position. A shadow root's content counts
// from its host, ahead of the host's own children. Elements in different roots are disconnected to
// compareDocumentPosition, so the order comes from walking the page. An element no walk reaches, in
// a closed root, comes last.
export function inDocumentOrder(...elements: Element[]): Element[] {
  const places = new Map<Element, number>();
  const visit = (parent: ParentNode): void => {
    for (const child of Array.from(parent.children)) {
      places.set(child, places.size);
      if (child.shadowRoot !== null) {
        visit(child.shadowRoot);
      }
      visit(child);
    }
  };
  visit(document);
  const placeOf = (element: Element): number => places.get(element) ?? Number.MAX_SAFE_INTEGER;
  return elements.toSorted((left, right) => placeOf(left) - placeOf(right));
}

// The elements a css selector or XPath expression matches, in document order, inside the one
// scope element when one is given and in the whole document otherwise. Inside a scope, an XPath
// expression starting with "/" is read from the scope (".//x"), as Playwright reads it, so it
// cannot reach outside. With hasText, only the elements whose text content, white space
// collapsed, contains it, ignoring case, as Playwright's hasText.
export function findStructural(kind: string, text: string, hasText: string, ...scope: Element[]): Element[] {
  const normalise = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
  const scopeElement = scope[0];
  const root: Document | Element = scopeElement ?? document;
  const found: Element[] = [];
  if (kind === "css") {
    const scopeRoot = scopeElement?.shadowRoot ?? null;
    const searches: (Document | Element | ShadowRoot)[] = scopeRoot === null ? [root] : [root, scopeRoot];
    for (const searched of searches) {
      found.push(...Array.from(searched.querySelectorAll(text)));
      for (const element of Array.from(searched.querySelectorAll("*"))) {
        if (element.shadowRoot !== null) {
          searches.push(element.shadowRoot);
        }
      }
    }
  } else {
    const expression = scopeElement !== undefined && text.startsWith("/") ? `.${text}` : text;
    const snapshot = document.evaluate(expression, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let index = 0; index < snapshot.snapshotLength; index++) {
      const node = snapshot.snapshotItem(index);
      if (node instanceof Element) {
        found.push(node);
      }
    }
  }
  if (hasText === "") {
    return found;
  }
  // A root's text is no part of its host's textContent, so a search for an error shown in a component
  // reads every root under the element.
  const textUnder = (element: Element): string => {
    const searches: (Element | ShadowRoot)[] = element.shadowRoot === null ? [element] : [element, element.shadowRoot];
    for (const searched of searches) {
      for (const inner of Array.from(searched.querySelectorAll("*"))) {
        if (inner.shadowRoot !== null) {
          searches.push(inner.shadowRoot);
        }
      }
    }
    return searches.map((searched) => Reflect.get(Node.prototype, "textContent", searched) as string).join(" ");
  };
  const wanted = normalise(hasText);
  return found.filter((element) => normalise(textUnder(element)).includes(wanted));
}
