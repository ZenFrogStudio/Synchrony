/** Hand-rolled route state — no navigation library, there are three screens. */
export type Route =
  | { screen: 'pair' }
  | { screen: 'instances' }
  | { screen: 'instance'; name: string; tab: string };
