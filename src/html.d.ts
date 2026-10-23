// wrangler's default module rules load *.html as a text module.
declare module "*.html" {
  const content: string;
  export default content;
}
