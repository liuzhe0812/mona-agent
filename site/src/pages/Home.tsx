import Navbar from "@/components/Navbar";
import PageDeck from "@/components/PageDeck";
import HeroSection from "@/components/HeroSection";
import AgentSection from "@/components/AgentSection";
import ToolsSection from "@/components/ToolsSection";
import FeaturesSection from "@/components/FeaturesSection";
import DesktopSection from "@/components/DesktopSection";
import QuickStartSection from "@/components/QuickStartSection";

export default function Home() {
  return (
    <PageDeck nav={<Navbar />}>
      <HeroSection />
      <AgentSection />
      <ToolsSection />
      <FeaturesSection />
      <DesktopSection />
      <QuickStartSection />
    </PageDeck>
  );
}
