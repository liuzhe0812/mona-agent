import ReactDOM from "react-dom/client";

import { StockEntry } from "./components/StockEntry";
import "./globals.css";

if (!import.meta.env.DEV) throw new Error("The stock development entry is unavailable in production");
const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
ReactDOM.createRoot(root).render(<StockEntry />);
