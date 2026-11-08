// Vite `?raw` imports in the main process (the file's text as a string, bundled at build time).
declare module '*?raw' {
  const text: string
  export default text
}
