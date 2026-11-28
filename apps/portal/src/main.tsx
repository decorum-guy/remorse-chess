import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/manrope";
import App from "./App";
import "./styles.css";

const TestBenchLanding = lazy(() => import('./TestBench').then(module => ({ default: module.TestBenchLanding })));

const TerritorialPractice = lazy(() => import("./TerritorialDistrict").then(module => ({ default: module.TerritorialPractice })));

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {['/test-bench','/games/test-bench'].includes(window.location.pathname) ? <Suspense fallback={<span className="spinner" />}><TestBenchLanding /></Suspense> : window.location.pathname === "/district-training" ? <Suspense fallback={<span className="spinner" />}><TerritorialPractice /></Suspense> : <App />}
  </React.StrictMode>,
);
