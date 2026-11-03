import React from "react";
import ReactDOM from "react-dom/client";
import "../globals.css";
import "../styles/resize-handles.css";
import "../i18n";
import { WorkApp } from "./WorkApp";

const root = document.getElementById("root");
if (!root) throw new Error("Work root is missing");
ReactDOM.createRoot(root).render(<React.StrictMode><WorkApp /></React.StrictMode>);
