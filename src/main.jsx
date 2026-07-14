import React from "react";
import { createRoot } from "react-dom/client";
import FireModel from "../fire_model.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <FireModel />
  </React.StrictMode>
);
