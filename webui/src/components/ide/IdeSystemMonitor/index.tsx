import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OverviewPanel } from "./OverviewPanel";
import { ProcessesPanel } from "./ProcessesPanel";
import { PortsPanel } from "./PortsPanel";

interface IdeSystemMonitorProps {
  sessionId: string;
}

export function IdeSystemMonitor({ sessionId }: IdeSystemMonitorProps) {
  return (
    <div className="flex h-full flex-col border-r bg-sidebar/50">
      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 justify-center py-2">
          <TabsList className="h-7">
            <TabsTrigger value="overview" className="px-2 text-caption">
              状态
            </TabsTrigger>
            <TabsTrigger value="processes" className="px-2 text-caption">
              进程
            </TabsTrigger>
            <TabsTrigger value="ports" className="px-2 text-caption">
              端口
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent
          value="overview"
          className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
        >
          <OverviewPanel sessionId={sessionId} />
        </TabsContent>
        <TabsContent
          value="processes"
          className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
        >
          <ProcessesPanel sessionId={sessionId} />
        </TabsContent>
        <TabsContent
          value="ports"
          className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
        >
          <PortsPanel sessionId={sessionId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
