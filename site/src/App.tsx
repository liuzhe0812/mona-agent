import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Home from "@/pages/Home";
import Changelog from "@/pages/Changelog";
import Tutorial from "@/pages/Tutorial";

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/changelog" element={<Changelog />} />
        <Route path="/tutorial" element={<Tutorial />} />
      </Routes>
    </Router>
  );
}
