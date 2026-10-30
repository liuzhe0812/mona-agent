import React from "react";
import ReactDOM from "react-dom/client";
import "../globals.css";
import { WorkApp } from "./WorkApp";

const root = document.getElementById("root");
if (!root) throw new Error("Work root is missing");
ReactDOM.createRoot(root).render(<React.StrictMode><WorkApp /></React.StrictMode>);
