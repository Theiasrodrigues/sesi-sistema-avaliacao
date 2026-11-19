(function () {
  'use strict';

  const SUPABASE_URL = 'https://tjwmnprapqjlnkblkbli.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_sAy4KxNMt7KD32PNMVJssw_cljDbpGQ';
  const STORAGE_KEY = 'sesi_evaluations';
  let syncInProgress = false;
  let syncTimer = null;

  async function supabaseRequest(path, options = {}) {
    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    const response = await fetch(SUPABASE_URL + '/rest/v1/' + path, { ...options, headers });
    const body = await response.text();
    let data = null;
    try { data = body ? JSON.parse(body) : null; } catch (_) { data = body; }
    if (!response.ok) {
      const message = data && (data.message || data.error_description || data.hint || data.details);
      throw new Error(message || ('Supabase HTTP ' + response.status));
    }
    return data;
  }

  function readLocalHistory() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (error) {
      console.error('[Supabase] Histórico local inválido:', error);
      return [];
    }
  }

  function writeLocalHistory(history) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    window.dispatchEvent(new CustomEvent('sesi:history-updated'));
  }

  function setSyncStatus(message, state) {
    let status = document.getElementById('sesiSyncStatus');
    if (!status) {
      const target = document.querySelector('.header-title');
      if (!target) return;
      status = document.createElement('small');
      status.id = 'sesiSyncStatus';
      status.style.cssText = 'display:block;margin-top:6px;font-size:12px;font-weight:600;';
      target.appendChild(status);
    }
    status.textContent = message;
    status.style.color = state === 'error' ? '#b42318' : state === 'ok' ? '#16834b' : '#666';
  }

  function getDiscipline(evaluation) {
    if (evaluation.rubricType === 'physical') return 'physical';
    if (evaluation.rubricType === 'sports') return 'sports';
    return 'robotics';
  }

  async function findOrCreateStudent(name, className) {
    const turmaRows = await supabaseRequest(
      'turmas?select=id,nome&nome=eq.' + encodeURIComponent(className) + '&limit=1'
    );
    if (!turmaRows || !turmaRows[0]) {
      throw new Error('Turma "' + className + '" não encontrada no banco online.');
    }
    const turmaId = turmaRows[0].id;

    const students = await supabaseRequest(
      'alunos?select=id,nome,turma_id&nome=eq.' + encodeURIComponent(name) + '&limit=100'
    );
    const exact = Array.isArray(students)
      ? students.find(student => Number(student.turma_id) === Number(turmaId))
      : null;
    if (exact) return exact.id;

    const created = await supabaseRequest('alunos', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ nome: name, turma_id: turmaId, ativo: true })
    });
    if (!created || !created[0]) throw new Error('Não foi possível cadastrar o aluno no banco online.');
    return created[0].id;
  }

  async function syncEvaluation(evaluation) {
    const alunoId = await findOrCreateStudent(evaluation.student, evaluation.class);
    const payload = {
      id: Number(evaluation.id),
      aluno_id: alunoId,
      disciplina: getDiscipline(evaluation),
      rubric_type: evaluation.rubricType,
      avaliador: evaluation.evaluator || '',
      atividade: evaluation.activity || '',
      escola: evaluation.school || 'SESI Milton Sobrosa Cordeiro',
      data_avaliacao: evaluation.dateISO || new Date().toISOString().slice(0, 10),
      scores: evaluation.scores || {},
      nota: Number(evaluation.total || 0),
      comentarios: evaluation.comments || '',
      score_scale_version: Number(evaluation.scoreScaleVersion || 2)
    };

    await supabaseRequest('avaliacoes?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(payload)
    });
  }

  function formatDate(dateISO) {
    if (!dateISO) return '';
    const parts = String(dateISO).slice(0, 10).split('-');
    if (parts.length !== 3) return String(dateISO);
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])).toLocaleDateString('pt-BR');
  }

  async function fetchDeletedEvaluationIds() {
    const rows = await supabaseRequest('avaliacoes_excluidas?select=id&limit=5000');
    return new Set((rows || []).map(row => String(row.id)));
  }

  async function fetchCloudHistory() {
    const rows = await supabaseRequest(
      'avaliacoes?select=id,aluno_id,disciplina,rubric_type,avaliador,atividade,escola,data_avaliacao,scores,nota,comentarios,score_scale_version&order=data_avaliacao.desc&limit=1000'
    );
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const studentIds = [...new Set(rows.map(row => Number(row.aluno_id)).filter(Number.isFinite))];
    const students = studentIds.length
      ? await supabaseRequest('alunos?select=id,nome,turma_id&id=in.(' + studentIds.join(',') + ')')
      : [];
    const classIds = [...new Set((students || []).map(student => Number(student.turma_id)).filter(Number.isFinite))];
    const classes = classIds.length
      ? await supabaseRequest('turmas?select=id,nome&id=in.(' + classIds.join(',') + ')')
      : [];

    const studentMap = new Map((students || []).map(student => [Number(student.id), student]));
    const classMap = new Map((classes || []).map(item => [Number(item.id), item]));

    return rows.map(row => {
      const student = studentMap.get(Number(row.aluno_id)) || {};
      const turma = classMap.get(Number(student.turma_id)) || {};
      const dateISO = row.data_avaliacao || '';
      return {
        id: Number(row.id),
        date: formatDate(dateISO),
        dateISO: dateISO,
        student: student.nome || 'Aluno não identificado',
        class: turma.nome || '',
        evaluator: row.avaliador || '',
        activity: row.atividade || '',
        school: row.escola || 'SESI Milton Sobrosa Cordeiro',
        rubricType: row.rubric_type || (row.disciplina === 'physical' ? 'physical' : row.disciplina === 'sports' ? 'sports' : 'junior'),
        scoreScaleVersion: Number(row.score_scale_version || 2),
        scores: row.scores || {},
        total: Number(row.nota || 0),
        comments: row.comentarios || ''
      };
    });
  }

  async function pullAndMergeCloudHistory() {
    const deletedIds = await fetchDeletedEvaluationIds();
    const cloudHistory = (await fetchCloudHistory()).filter(item => !deletedIds.has(String(item.id)));
    const localHistory = readLocalHistory().filter(item => !deletedIds.has(String(item.id)));
    const localById = new Map(localHistory.map(item => [String(item.id), item]));
    const merged = new Map(localHistory.map(item => [String(item.id), item]));

    cloudHistory.forEach(cloudItem => {
      const localItem = localById.get(String(cloudItem.id));
      // O banco online é a fonte compartilhada; preservamos anexos locais já existentes.
      merged.set(String(cloudItem.id), {
        ...(localItem || {}),
        ...cloudItem,
        photo: localItem && localItem.photo ? localItem.photo : ''
      });
    });

    const result = [...merged.values()].sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
    writeLocalHistory(result);
    return { cloudCount: cloudHistory.length, totalCount: result.length };
  }

  async function synchronizeAll() {
    if (syncInProgress) return;
    syncInProgress = true;
    setSyncStatus('Sincronizando avaliações...', 'busy');
    try {
      // Exclusões registradas na nuvem são definitivas e não podem ser recriadas por cópias locais antigas.
      const deletedIds = await fetchDeletedEvaluationIds();
      const localBeforeCleanup = readLocalHistory();
      const cleanedLocal = localBeforeCleanup.filter(item => !deletedIds.has(String(item.id)));
      if (cleanedLocal.length !== localBeforeCleanup.length) writeLocalHistory(cleanedLocal);

      // Envia somente registros que ainda não existem na nuvem.
      // Assim, uma cópia local antiga nunca sobrescreve uma avaliação mais recente de outro computador.
      const cloudRows = await supabaseRequest('avaliacoes?select=id&limit=1000');
      const cloudIds = new Set((cloudRows || []).map(row => String(row.id)));
      const localHistory = readLocalHistory();
      for (const evaluation of localHistory) {
        if (!evaluation || !evaluation.id || deletedIds.has(String(evaluation.id)) || !evaluation.student || !evaluation.class) continue;
        if (!cloudIds.has(String(evaluation.id))) await syncEvaluation(evaluation);
      }

      const result = await pullAndMergeCloudHistory();
      setSyncStatus('Sincronizado • ' + result.cloudCount + ' avaliações na nuvem', 'ok');
      window.__supabaseLastSyncError = null;
      console.info('[Supabase] Sincronização concluída:', result);
    } catch (error) {
      window.__supabaseLastSyncError = error;
      setSyncStatus('Falha na sincronização: ' + error.message, 'error');
      console.error('[Supabase] Falha na sincronização:', error);
    } finally {
      syncInProgress = false;
    }
  }

  async function synchronizeChangedEvaluation(evaluation) {
    if (!evaluation) return synchronizeAll();
    setSyncStatus('Enviando avaliação para a nuvem...', 'busy');
    try {
      await syncEvaluation(evaluation);
      const result = await pullAndMergeCloudHistory();
      setSyncStatus('Salvo na nuvem • ' + result.cloudCount + ' avaliações compartilhadas', 'ok');
      window.__supabaseLastSyncError = null;
    } catch (error) {
      window.__supabaseLastSyncError = error;
      setSyncStatus('Salvo somente neste computador: ' + error.message, 'error');
      console.error('[Supabase] Falha ao enviar avaliação:', error);
    }
  }

  function installSaveIntegration() {
    if (typeof window.saveEvaluation !== 'function' || window.saveEvaluation.__supabaseWrapped) return false;
    const originalSaveEvaluation = window.saveEvaluation;

    function wrappedSaveEvaluation(silent = false) {
      const before = new Map(readLocalHistory().map(item => [String(item.id), JSON.stringify(item)]));
      const result = originalSaveEvaluation.call(this, silent);
      if (result) {
        const after = readLocalHistory();
        const changed = after.find(item => !before.has(String(item.id)) || before.get(String(item.id)) !== JSON.stringify(item));
        if (changed) synchronizeChangedEvaluation(changed);
      }
      return result;
    }

    wrappedSaveEvaluation.__supabaseWrapped = true;
    window.saveEvaluation = wrappedSaveEvaluation;
    console.info('[Supabase] Integração de envio e recebimento instalada.');
    return true;
  }


  // Registra a exclusão antes de remover a avaliação. Assim, outros dispositivos
  // também removem a cópia local e não reenviam o registro apagado.
  window.deleteCloudEvaluation = async function (evaluationId) {
    const id = Number(evaluationId);
    if (!Number.isFinite(id)) throw new Error('ID de avaliação inválido.');
    await supabaseRequest('avaliacoes_excluidas?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: id })
    });
    await supabaseRequest('avaliacoes?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
  };

  async function start() {
    if (!installSaveIntegration()) {
      let attempts = 0;
      const installTimer = setInterval(() => {
        attempts += 1;
        if (installSaveIntegration() || attempts >= 50) clearInterval(installTimer);
      }, 100);
    }
    await synchronizeAll();

    // Atualiza ao voltar para a aba e periodicamente para refletir avaliações dos outros professores.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) synchronizeAll();
    });
    window.addEventListener('focus', synchronizeAll);
    if (!syncTimer) syncTimer = setInterval(() => {
      if (!document.hidden) synchronizeAll();
    }, 60000);
  }

  if (document.readyState === 'complete') {
    start();
  } else {
    window.addEventListener('load', start, { once: true });
  }
})();