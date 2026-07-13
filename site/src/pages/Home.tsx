import Navbar from "@/components/Navbar";
import PageDeck from "@/components/PageDeck";
import HeroSection from "@/components/HeroSection";
import ToolsSection from "@/components/ToolsSection";
import AgentSection from "@/components/AgentSection";
import SedimentSection from "@/components/SedimentSection";
import EvolutionSection from "@/components/EvolutionSection";
import FeaturesSection from "@/components/FeaturesSection";
import DesktopSection from "@/components/DesktopSection";
import QuickStartSection from "@/components/QuickStartSection";

export default function Home() {
  return (
    <PageDeck nav={<Navbar />}>
      <HeroSection />
      <ToolsSection />
      <AgentSection />
      <SedimentSection />
      <EvolutionSection />
      <FeaturesSection />
      <DesktopSection />
      <QuickStartSection />
    </PageDeck>
  );
}
