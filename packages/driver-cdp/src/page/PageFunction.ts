// A function that runs inside the page, sent as its source text with toString(). It must be declared
// at the top level of an in-page file, where nothing it uses may come from its module: the in-page
// rule in tools/eslint lists those files and checks both.
export type PageFunction = (...inputs: never[]) => unknown;
