// Vite handles CSS imports; give TypeScript a module shape for them.
declare module '*.css';

// Vite `?worker` imports resolve to a Worker constructor.
declare module '*?worker' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
