import { useState, type FormEvent } from "react";
import { categoryLabel } from "./display.js";
import {
  addInterestValue,
  browserPreferencesStorage,
  CATEGORY_VALUES,
  clearPreferences,
  emptyInterests,
  loadPreferences,
  MAX_CATEGORIES,
  MAX_INTEREST_CHARACTERS,
  MAX_TEXT_INTERESTS,
  savePreferences,
  TEXT_INTEREST_FIELDS,
  type BriefingInterests,
  type LoadPreferencesResult,
  type PreferencesStorage,
  type TextInterestField,
} from "./preferences-store.js";

interface PreferencesProps {
  storage?: PreferencesStorage | null;
}

type Feedback = { kind: "status" | "error"; text: string };
type Drafts = Record<TextInterestField, string>;
type FieldMessages = Partial<Record<TextInterestField, string>>;

const TEXT_FIELD_COPY: Record<TextInterestField, { label: string; help: string }> = {
  places: { label: "Tempat", help: "Contoh: kecamatan, kelurahan, atau tempat umum." },
  services: { label: "Layanan", help: "Contoh: operator, rute, atau fasilitas." },
  institutions: { label: "Institusi", help: "Contoh: kampus, sekolah, atau instansi." },
  audiences: { label: "Kelompok", help: "Contoh: mahasiswa, orang tua, atau pengguna angkutan umum." },
};

function initialFeedback(result: LoadPreferencesResult): Feedback | null {
  if (result.status === "loaded") return { kind: "status", text: "Minat yang tersimpan di browser ini telah dimuat." };
  if (result.status === "malformed") {
    return {
      kind: "error",
      text: "Data minat tersimpan tidak dapat dibaca. Kami tidak mengubahnya. Hapus data tersimpan secara eksplisit untuk mulai lagi.",
    };
  }
  if (result.status === "unavailable") {
    return {
      kind: "error",
      text: "Penyimpanan browser tidak dapat dibaca. Minat sebelumnya mungkin masih ada dan belum ditimpa.",
    };
  }
  return { kind: "status", text: "Belum ada minat yang tersimpan di browser ini." };
}

function validationMessage(status: "empty" | "duplicate" | "too-long" | "too-many") {
  switch (status) {
    case "empty":
      return "Nilai kosong diabaikan.";
    case "duplicate":
      return "Minat yang sama sudah ada.";
    case "too-long":
      return "Nilai melebihi 128 karakter Unicode. Persingkat nilainya; teks tidak dipotong otomatis.";
    case "too-many":
      return "Maksimal 30 minat untuk bidang ini.";
  }
}

function feedbackAfterEdit(text: string): Feedback {
  return { kind: "status", text };
}

export function Preferences({ storage }: PreferencesProps) {
  const [activeStorage] = useState<PreferencesStorage | null>(() =>
    storage === undefined ? browserPreferencesStorage() : storage,
  );
  const [state, setState] = useState(() => {
    const loaded = loadPreferences(activeStorage);
    return {
      loadStatus: loaded.status,
      interests: loaded.status === "loaded" || loaded.status === "empty" ? loaded.interests : emptyInterests(),
      feedback: initialFeedback(loaded),
    };
  });
  const [drafts, setDrafts] = useState<Drafts>({ places: "", services: "", institutions: "", audiences: "" });
  const [fieldMessages, setFieldMessages] = useState<FieldMessages>({});

  const updateInterests = (update: (current: BriefingInterests) => BriefingInterests, message: string) => {
    setState((current) => ({
      ...current,
      interests: update(current.interests),
      feedback: feedbackAfterEdit(message),
    }));
  };

  const addValue = (field: TextInterestField, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = addInterestValue(state.interests[field], drafts[field]);
    if (result.status !== "added") {
      setFieldMessages((current) => ({ ...current, [field]: validationMessage(result.status) }));
      return;
    }
    setFieldMessages((current) => ({ ...current, [field]: undefined }));
    setDrafts((current) => ({ ...current, [field]: "" }));
    updateInterests(
      (current) => ({ ...current, [field]: result.values }),
      "Minat ditambahkan. Simpan untuk menyimpannya di browser ini.",
    );
  };

  const removeValue = (field: TextInterestField, index: number) => {
    updateInterests(
      (current) => ({ ...current, [field]: current[field].filter((_, valueIndex) => valueIndex !== index) }),
      "Minat dihapus dari formulir. Simpan perubahan untuk memperbarui data browser.",
    );
  };

  const toggleCategory = (category: BriefingInterests["categories"][number], checked: boolean) => {
    updateInterests(
      (current) => ({
        ...current,
        categories: checked
          ? [...current.categories, category]
          : current.categories.filter((value) => value !== category),
      }),
      "Kategori diperbarui. Simpan untuk menyimpannya di browser ini.",
    );
  };

  const save = () => {
    const result = savePreferences(activeStorage, state.interests);
    if (result.status === "saved") {
      setState({
        loadStatus: "loaded",
        interests: result.interests,
        feedback: { kind: "status", text: "Minat berhasil disimpan di browser ini." },
      });
      return;
    }
    if (result.status === "invalid") {
      setState((current) => ({
        ...current,
        feedback: { kind: "error", text: "Minat belum tersimpan karena ada nilai yang tidak memenuhi batas." },
      }));
      return;
    }
    setState((current) => ({
      ...current,
      feedback: {
        kind: "error",
        text: "Minat belum tersimpan. Browser menolak penulisan, misalnya karena ruang penyimpanan penuh atau dibatasi. Formulir tetap tersedia untuk dicoba lagi.",
      },
    }));
  };

  const clear = () => {
    const result = clearPreferences(activeStorage);
    if (result.status === "cleared") {
      setState({
        loadStatus: "empty",
        interests: emptyInterests(),
        feedback: { kind: "status", text: "Semua minat tersimpan telah dihapus dari browser ini." },
      });
      setDrafts({ places: "", services: "", institutions: "", audiences: "" });
      setFieldMessages({});
      return;
    }
    setState((current) => ({
      ...current,
      feedback: {
        kind: "error",
        text: "Minat belum dihapus karena browser menolak penghapusan. Data yang terlihat tetap dipertahankan.",
      },
    }));
  };

  const unreadable = state.loadStatus === "malformed";

  return (
    <main id="main-content" className="main-shell preferences-page">
      <section className="page-intro" aria-labelledby="preferences-title">
        <div>
          <p className="section-kicker">Minat di perangkat ini</p>
          <h1 id="preferences-title">Ringkasan saya</h1>
        </div>
        <p className="page-intro__copy">
          Periksa dan ubah minat yang ingin Anda simpan untuk browser ini.
        </p>
      </section>

      <section className="preferences-privacy" aria-label="Penyimpanan minat">
        <strong>Minat tetap di browser ini.</strong>
        <p>
          Minat tidak dikirim ke layanan. Menghapus data browser juga menghapus minat tersimpan di sini.
        </p>
      </section>

      <section className="preferences-briefing" aria-labelledby="briefing-status-title">
        <p className="section-kicker">Pembaruan pribadi</p>
        <h2 id="briefing-status-title">Briefing dan pembaruan belum terhubung</h2>
        <p>
          Layar ini hanya menyimpan pilihan Anda. Belum ada hasil kecocokan atau pembaruan pribadi yang tersedia;
          keadaan ini tidak menunjukkan bahwa semua area aman.
        </p>
        <p>
          Record contoh di Jelajah tidak digunakan sebagai kecocokan. Relevansi setiap event tetap “Tidak dinilai”.
        </p>
      </section>

      {state.feedback && (
        <p className="preferences-feedback" role={state.feedback.kind === "error" ? "alert" : "status"}>
          {state.feedback.text}
        </p>
      )}

      {unreadable ? (
        <section className="preferences-recovery" aria-labelledby="preferences-recovery-title">
          <div>
            <h2 id="preferences-recovery-title">Data minat perlu dipulihkan</h2>
            <p>
              Isi yang tersimpan mungkin rusak atau memakai versi yang tidak dikenal. Minat lama belum diubah.
              Hapus data minat tersimpan secara eksplisit jika Anda ingin mulai dengan formulir kosong.
            </p>
          </div>
          <button className="button button--quiet" type="button" onClick={clear}>
            Hapus data minat tersimpan dan mulai lagi
          </button>
        </section>
      ) : (
        <>
          <section className="preferences-grid" aria-label="Minat tempat dan layanan">
            {TEXT_INTEREST_FIELDS.map((field) => {
              const copy = TEXT_FIELD_COPY[field];
              const values = state.interests[field];
              const inputId = "interest-" + field;
              const helpId = inputId + "-help";
              const errorId = inputId + "-error";
              const fieldMessage = fieldMessages[field];
              return (
                <section className="preference-card" key={field} aria-labelledby={inputId + "-title"}>
                  <h2 id={inputId + "-title"}>{copy.label}</h2>
                  <p id={helpId} className="preference-card__help">{copy.help}</p>
                  <form className="preference-entry" onSubmit={(event) => addValue(field, event)}>
                    <label htmlFor={inputId}>Tambah {copy.label.toLocaleLowerCase("id-ID")}</label>
                    <div className="preference-entry__controls">
                      <input
                        id={inputId}
                        name={field}
                        type="text"
                        value={drafts[field]}
                        aria-describedby={fieldMessage ? helpId + " " + errorId : helpId}
                        aria-invalid={fieldMessage ? true : undefined}
                        onChange={(event) => {
                          setDrafts((current) => ({ ...current, [field]: event.target.value }));
                          setFieldMessages((current) => ({ ...current, [field]: undefined }));
                        }}
                      />
                      <button className="button button--quiet" type="submit">Tambah</button>
                    </div>
                    <p className="preference-limit">
                      {values.length}/{MAX_TEXT_INTERESTS} minat · maksimal {MAX_INTEREST_CHARACTERS} karakter Unicode per nilai
                    </p>
                    {fieldMessage && <p className="preference-field-error" id={errorId} role="alert">{fieldMessage}</p>}
                  </form>
                  {values.length === 0 ? (
                    <p className="preference-empty">Belum ada minat untuk {copy.label.toLocaleLowerCase("id-ID")}.</p>
                  ) : (
                    <ul className="preference-values" aria-label={"Minat " + copy.label.toLocaleLowerCase("id-ID")}>
                      {values.map((value, index) => (
                        <li className="preference-value" key={value + "-" + index}>
                          <span>{value}</span>
                          <button
                            className="preference-value__remove"
                            type="button"
                            aria-label={"Hapus " + value + " dari " + copy.label}
                            onClick={() => removeValue(field, index)}
                          >
                            Hapus
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </section>

          <fieldset className="preference-card preference-categories">
            <legend>Kategori yang diikuti</legend>
            <p className="preference-card__help">
              Pilih sampai {MAX_CATEGORIES} kategori yang tersedia dalam kontrak briefing.
            </p>
            <div className="preference-category-grid">
              {CATEGORY_VALUES.map((category) => (
                <label className="preference-category" key={category}>
                  <input
                    type="checkbox"
                    name="categories"
                    value={category}
                    checked={state.interests.categories.includes(category)}
                    onChange={(event) => toggleCategory(category, event.target.checked)}
                  />
                  <span>{categoryLabel(category)}</span>
                </label>
              ))}
            </div>
            <p className="preference-limit">{state.interests.categories.length}/{MAX_CATEGORIES} kategori dipilih</p>
          </fieldset>

          <div className="preferences-actions">
            <button className="button button--primary" type="button" onClick={save}>Simpan di perangkat ini</button>
            <button className="button button--quiet" type="button" onClick={clear}>Hapus semua minat</button>
          </div>
        </>
      )}
    </main>
  );
}