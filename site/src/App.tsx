import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Home from "@/pages/Home";
import Changelog from "@/pages/Changelog";

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/changelog" element={<Changelog />} />
      </Routes>
    </Router>
  );
}
