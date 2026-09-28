(function () {
  'use strict';

  const SUPABASE_URL = 'https://tjwmnprapqjlnkblkbli.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_sAy4KxNMt7KD32PNMVJssw_cljDbpGQ';

  async function supabaseRequest(path, options = {}) {
    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    const response = await fetch(SUPABASE_URL + '/rest/v1/' + path, { ...options, headers });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!response.ok) {
      const message = data && (data.message || data.error_description || data.hint || data.details);
      throw new Error(message || ('Supabase HTTP ' + response.status));
    }
    return data;
  }

  async function findOrCreateStudent(name, className) {
    const students = await supabaseRequest(
      'alunos?select=id,nome,turma_id&nome=eq.' + encodeURIComponent(name) + '&limit=20'
    );
    const turmaRows = await supabaseRequest(
      'turmas?select=id,nome&nome=eq.' + encodeURIComponent(className) + '&limit=1'
    );
    if (!turmaRows || !turmaRows[0]) throw new Error('Turma não encontrada no Supabase: ' + className);
    const turmaId = turmaRows[0].id;

    if (Array.isArray(students) && students.length) {
      const exact = students.find(s => Number(s.turma_id) === Number(turmaId));
      if (exact) return exact.id;
    }

    const created = await supabaseRequest('alunos', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ nome: name, turma_id: turmaId, ativo: true })
    });
    if (!created || !created[0]) throw new Error('Não foi possível cadastrar o aluno.');
    return created[0].id;
  }

  function getDiscipline() {
    if (typeof window.getActiveDiscipline === 'function') return window.getActiveDiscipline();
    if (document.body.classList.contains('discipline-physical')) return 'physical';
    if (document.body.classList.contains('discipline-sports')) return 'sports';
    return 'robotics';
  }

  async function syncEvaluation(evaluation) {
    const alunoId = await findOrCreateStudent(evaluation.student, evaluation.class);
    const payload = {
      id: Number(evaluation.id),
      aluno_id: alunoId,
      disciplina: getDiscipline(),
      rubric_type: evaluation.rubricType,
      avaliador: evaluation.evaluator || '',
      atividade: evaluation.activity || '',
      escola: 'SESI Milton Sobrosa Cordeiro',
      data_avaliacao: evaluation.dateISO,
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

  function install() {
    if (typeof window.saveEvaluation !== 'function' || window.saveEvaluation.__supabaseWrapped) return false;
    const originalSaveEvaluation = window.saveEvaluation;

    async function syncLatestEvaluation() {
      try {
        const history = JSON.parse(localStorage.getItem('sesi_evaluations') || '[]');
        if (!history.length) return;
        await syncEvaluation(history[history.length - 1]);
        window.__supabaseLastSyncError = null;
        console.info('[Supabase] Avaliação enviada ao banco.');
      } catch (error) {
        console.error('[Supabase] Falha ao salvar avaliação:', error);
        window.__supabaseLastSyncError = error;
        alert('A avaliação foi salva neste computador, mas NÃO foi enviada ao banco online.\n\nErro: ' + error.message);
      }
    }

    function wrappedSaveEvaluation(silent = false) {
      const result = originalSaveEvaluation.call(this, silent);
      if (result) setTimeout(syncLatestEvaluation, 0);
      return result;
    }

    wrappedSaveEvaluation.__supabaseWrapped = true;
    window.saveEvaluation = wrappedSaveEvaluation;
    console.info('[Supabase] Integração instalada.');
    return true;
  }

  if (!install()) {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (install() || attempts >= 50) clearInterval(timer);
    }, 100);
  }
})();
