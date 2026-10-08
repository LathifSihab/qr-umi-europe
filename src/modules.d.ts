// Non-JS files bundled into the Worker (see "rules" in wrangler.jsonc).
declare module "*.html" {
  const text: string;
  export default text;
}
declare module "*.css" {
  const text: string;
  export default text;
}
declare module "*.client.js" {
  const text: string;
  export default text;
}
declare module "*.svg" {
  const text: string;
  export default text;
}
