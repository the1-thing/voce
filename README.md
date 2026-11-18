# Voce

Un bottone solo: lo premi, parli, lo premi di nuovo. La registrazione parte per una casella privata e viene trascritta più tardi sul computer.

- `index.html`, `style.css`, `app.js`: la pagina e il bottone.
- `outbox.js`: tiene le registrazioni sul telefono finché non sono arrivate.
- `sw.js`: fa aprire l'app senza rete e invia ciò che aspetta quando la rete torna.
- `config.js`: dove vanno le note. Non contiene segreti: la chiave resta sul telefono.
