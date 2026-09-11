import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import {
  addTask,
  AskedQuestion,
  answerQuestion,
  deleteTask,
  editTask,
  InstanceSnapshot,
  Question,
  requestPlan,
  requestStatus,
  runTask,
  Task
} from '../lib/api';
import { palette, shared } from '../lib/theme';
import { Banner, Button, Chip, ConfirmSheet, PromptModal, Row } from '../components/ui';

interface Props {
  snapshot: InstanceSnapshot;
  refresh: () => void;
  refreshing: boolean;
}

interface PlanProgress {
  requestId: string;
  status: string;
  note?: string;
  startedAt: number;
  polling: boolean;
}

const TEN_MINUTES_MS = 10 * 60 * 1000;

export default function TasksTab({ snapshot, refresh }: Props) {
  const { instance, tasks, questions, settings } = snapshot;

  const [addText, setAddText] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<{ name: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ type: 'archive' | 'run'; task: Task } | null>(null);
  const [progress, setProgress] = useState<Record<string, PlanProgress>>({});

  const planModelField = settings?.groups.flatMap((g) => g.fields).find((f) => f.key === 'planModel');
  const [selectedModel, setSelectedModel] = useState<string>(
    typeof settings?.values.planModel === 'string' ? (settings.values.planModel as string) : ''
  );

  // Single 2s ticker driving every row's plan/series progress, stopped per-row
  // once it reaches `done` or has run for 10 minutes.
  useEffect(() => {
    const active = Object.entries(progress).filter(([, p]) => p.polling);
    if (!active.length) return;
    const timer = setInterval(async () => {
      for (const [taskName, p] of active) {
        try {
          const res = await requestStatus(instance, p.requestId);
          const stop = res.status === 'done' || Date.now() - p.startedAt > TEN_MINUTES_MS;
          const note = res.status === 'done' && res.outcome ? String((res.outcome as { note?: string }).note ?? '') : undefined;
          setProgress((prev) => ({ ...prev, [taskName]: { ...prev[taskName], status: res.status, note, polling: !stop } }));
          if (res.status === 'done') refresh();
        } catch {
          // Next tick retries; a stale tunnel here should not stop the row silently forever.
        }
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [progress, instance, refresh]);

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setError(undefined);
    try {
      const out = await action();
      refresh();
      return out;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      return undefined;
    }
  }

  async function handleAdd() {
    const text = addText.trim();
    if (!text) return;
    setAddText('');
    await run(() => addTask(instance, text));
  }

  async function handleSaveEdit() {
    if (!editing) return;
    const target = editing;
    setEditing(null);
    await run(() => editTask(instance, target.name, target.text));
  }

  async function handleConfirm() {
    if (!confirm) return;
    const target = confirm;
    setConfirm(null);
    if (target.type === 'archive') {
      await run(() => deleteTask(instance, target.task.name));
    } else {
      await run(() => runTask(instance, target.task.name, selectedModel || undefined));
    }
  }

  async function handleGenerate(task: Task, series: boolean) {
    setError(undefined);
    try {
      const res = await requestPlan(instance, task.name, { series, model: selectedModel || undefined });
      setProgress((prev) => ({
        ...prev,
        [task.name]: { requestId: res.requestId, status: 'unclaimed', startedAt: Date.now(), polling: true }
      }));
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not request a plan.');
    }
  }

  async function handleAnswer(question: Question, answers: { id: string; answer: string }[]) {
    await run(() => answerQuestion(instance, question.id, answers));
  }

  const unanswered = questions.filter((q) => !q.answeredAt);

  return (
    <View style={{ flex: 1 }}>
      {error ? <Banner kind="error" message={error} /> : null}

      <Row style={{ gap: 8 }}>
        <TextInput
          value={addText}
          onChangeText={setAddText}
          onSubmitEditing={handleAdd}
          placeholder="Capture a task…"
          placeholderTextColor={palette.textDim}
          style={inputStyle}
          returnKeyType="done"
        />
        <Button label="Add" onPress={handleAdd} disabled={!addText.trim()} />
      </Row>

      {planModelField?.options ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {planModelField.options.map((opt) => (
              <Chip
                key={opt.value}
                label={opt.label}
                selected={selectedModel === opt.value}
                onPress={() => setSelectedModel(opt.value)}
              />
            ))}
          </View>
        </ScrollView>
      ) : null}

      <ScrollView style={{ marginTop: 12 }}>
        {unanswered.map((q) => (
          <QuestionCard key={q.id} question={q} onSubmit={handleAnswer} />
        ))}

        {tasks.length === 0 ? (
          <Text style={{ color: palette.textDim, marginTop: 8 }}>No tasks captured yet.</Text>
        ) : null}

        {tasks.map((task) => (
          <TaskRow
            key={task.name}
            task={task}
            progress={progress[task.name]}
            onEdit={() => setEditing({ name: task.name, text: task.text })}
            onArchive={() => setConfirm({ type: 'archive', task })}
            onRun={() => setConfirm({ type: 'run', task })}
            onPlan={() => handleGenerate(task, false)}
            onSeries={() => handleGenerate(task, true)}
          />
        ))}
      </ScrollView>

      <PromptModal
        visible={!!editing}
        title="Edit task"
        value={editing?.text ?? ''}
        onChangeValue={(text) => setEditing((prev) => (prev ? { ...prev, text } : prev))}
        onCancel={() => setEditing(null)}
        onSave={handleSaveEdit}
      />

      <ConfirmSheet
        visible={!!confirm}
        title={confirm?.type === 'archive' ? 'Archive task' : 'Run task'}
        message={
          confirm?.type === 'archive'
            ? 'This moves the task out of the inbox into its archive.'
            : 'Runs via the desktop scheduler within ~30s; the task stays in the inbox.'
        }
        confirmLabel={confirm?.type === 'archive' ? 'Archive' : 'Run'}
        destructive={confirm?.type === 'archive'}
        onCancel={() => setConfirm(null)}
        onConfirm={handleConfirm}
      />
    </View>
  );
}

function TaskRow({
  task,
  progress,
  onEdit,
  onArchive,
  onRun,
  onPlan,
  onSeries
}: {
  task: Task;
  progress?: PlanProgress;
  onEdit: () => void;
  onArchive: () => void;
  onRun: () => void;
  onPlan: () => void;
  onSeries: () => void;
}) {
  const firstLine = task.text.split('\n')[0];
  const busy = progress ? progress.polling : false;
  const captured = new Date(task.captured).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  return (
    <View style={[shared.card, { marginBottom: 10 }]}>
      <Text style={{ color: palette.text, fontSize: 15, fontWeight: '600' }}>{firstLine}</Text>
      <Text style={{ color: palette.textDim, fontSize: 12, marginTop: 4 }}>{captured}</Text>

      {progress ? (
        <View style={{ marginTop: 8, alignSelf: 'flex-start' }}>
          <Chip
            label={progress.status === 'done' ? `Done${progress.note ? `: ${progress.note}` : ''}` : progress.status}
            color={progress.status === 'done' ? palette.status.success : palette.status.pending}
          />
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <Button label="Edit" variant="ghost" onPress={onEdit} disabled={busy} />
        <Button label="Plan" variant="ghost" onPress={onPlan} disabled={busy} />
        <Button label="Series" variant="ghost" onPress={onSeries} disabled={busy} />
        <Button label="Run" variant="ghost" onPress={onRun} disabled={busy} />
        <Button label="Archive" variant="danger" onPress={onArchive} disabled={busy} />
      </View>
    </View>
  );
}

function QuestionCard({
  question,
  onSubmit
}: {
  question: Question;
  onSubmit: (question: Question, answers: { id: string; answer: string }[]) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const submittedRef = useRef(false);

  function setAnswer(q: AskedQuestion, value: string) {
    setAnswers((prev) => ({ ...prev, [q.id]: value }));
  }

  async function handleSubmit() {
    const filled = question.questions.every((q) => (answers[q.id] ?? '').trim().length > 0);
    if (!filled || submittedRef.current) return;
    submittedRef.current = true;
    await onSubmit(
      question,
      question.questions.map((q) => ({ id: q.id, answer: answers[q.id] }))
    );
  }

  return (
    <View style={[shared.card, { marginBottom: 12, borderColor: palette.accent }]}>
      <Text style={{ color: palette.text, fontWeight: '600' }}>{question.summary}</Text>
      {question.questions.map((q) => (
        <View key={q.id} style={{ marginTop: 10 }}>
          <Text style={{ color: palette.textDim, marginBottom: 6 }}>{q.question}</Text>
          {q.options?.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {q.options.map((opt) => (
                <Chip key={opt} label={opt} selected={answers[q.id] === opt} onPress={() => setAnswer(q, opt)} />
              ))}
            </View>
          ) : (
            <TextInput
              value={answers[q.id] ?? ''}
              onChangeText={(text) => setAnswer(q, text)}
              placeholder="Your answer…"
              placeholderTextColor={palette.textDim}
              style={inputStyle}
              multiline
            />
          )}
        </View>
      ))}
      <Button label="Submit" onPress={handleSubmit} style={{ marginTop: 14 }} />
    </View>
  );
}

const inputStyle = {
  flex: 1,
  minHeight: 44,
  borderWidth: 1,
  borderColor: palette.border,
  borderRadius: 10,
  paddingHorizontal: 12,
  color: palette.text
};
