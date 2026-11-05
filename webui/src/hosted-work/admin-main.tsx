import React from "react";
import ReactDOM from "react-dom/client";
import "../globals.css";
import { AdminApp } from "./AdminApp";

const root = document.getElementById("root");
if (!root) throw new Error("Admin root is missing");
ReactDOM.createRoot(root).render(<React.StrictMode><AdminApp /></React.StrictMode>);
