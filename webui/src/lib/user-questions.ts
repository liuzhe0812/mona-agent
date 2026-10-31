export interface UserQuestion {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multi_select?: boolean;
}

export interface UserQuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

export interface UserQuestionRequest {
  request_id: string;
  agent_id: string;
  questions: UserQuestion[];
}
