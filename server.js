const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

// Servir archivos estáticos desde la carpeta public
app.use(express.static(__dirname + '/public'));

let estadoJuego = {
    jugadores: [],
    ronda: 1,
    sentidoHorario: true,
    turnoActualIdx: 0,
    cartaEnMesa: null,
    mazo: []
};

function generarMazo() {
    const palos = ['Corazones', 'Diamantes', 'Tréboles', 'Picas'];
    let mazo = [];
    for (let num = 1; num <= 10; num++) {
        palos.forEach(palo => mazo.push({ numero: num, palo: palo, esComodin: false }));
    }
    mazo.push({ numero: 0, palo: 'Joker', esComodin: true });
    mazo.push({ numero: 0, palo: 'Joker', esComodin: true });
    return mazo.sort(() => Math.random() - 0.5);
}

function truncarPuntaje(valor) {
    return Math.floor(valor * 10) / 10;
}

function avanzarTurno() {
    let paso = estadoJuego.sentidoHorario ? 1 : -1;
    let inicial = estadoJuego.turnoActualIdx;
    do {
        estadoJuego.turnoActualIdx = (estadoJuego.turnoActualIdx + paso + 6) % 6;
    } while (!estadoJuego.jugadores[estadoJuego.turnoActualIdx].activo && estadoJuego.turnoActualIdx !== inicial);
    
    io.emit('actualizar_estado', limpiarParaClientes());
}

function limpiarParaClientes() {
    return {
        ronda: estadoJuego.ronda,
        sentidoHorario: estadoJuego.sentidoHorario,
        turnoActualIdx: estadoJuego.turnoActualIdx,
        cartaEnMesa: estadoJuego.cartaEnMesa ? { declarada: estadoJuego.cartaEnMesa.declarada, tipoDeclarado: estadoJuego.cartaEnMesa.tipoDeclarado } : null,
        jugadores: estadoJuego.jugadores.map(j => ({
            nombre: j.nombre,
            puntaje: j.puntaje,
            activo: j.activo,
            cartasRestantes: j.mano.length,
            turnos: j.turnos
        }))
    };
}

io.on('connection', (socket) => {
    socket.on('unirse', (nombre) => {
        if (estadoJuego.jugadores.length < 6) {
            estadoJuego.jugadores.push({
                id: estadoJuego.jugadores.length,
                socketId: socket.id,
                nombre: nombre,
                puntaje: 10.0,
                mano: [],
                turnos: 0,
                mentiras: 0,
                activo: true
            });
            
            socket.emit('tu_id', estadoJuego.jugadores.length - 1);
            io.emit('actualizar_estado', limpiarParaClientes());

            if (estadoJuego.jugadores.length === 6) {
                iniciarRonda();
            }
        } else {
            socket.emit('error_sala', 'Sala llena');
        }
    });

    function iniciarRonda() {
        estadoJuego.mazo = generarMazo();
        estadoJuego.jugadores.forEach(j => {
            if (j.activo) {
                j.mano = estadoJuego.mazo.splice(0, 7);
                j.turnos = 0;
                if (estadoJuego.ronda > 1) j.mentiras = 0;
                io.to(j.socketId).emit('tu_mano', j.mano);
            }
        });
        io.emit('actualizar_estado', limpiarParaClientes());
    }

    socket.on('declarar_carta', ({ idxCarta, numeroDeclarado, tipoDeclarado }) => {
        let j = estadoJuego.turnoActualIdx;
        let jugador = estadoJuego.jugadores[j];
        if (socket.id !== jugador.socketId) return;

        let cartaReal = jugador.mano[idxCarta];
        let numReal = cartaReal.numero;
        let numDec = parseInt(numeroDeclarado);

        // Regla de Exclusión por Proximidad (Sección 5)
        if (!cartaReal.esComodin && tipoDeclarado !== 'comodin' && numReal !== numDec) {
            let diferencia = Math.abs(numReal - numDec);
            if (diferencia === 1 || diferencia === 2) {
                socket.emit('error_jugada', `Regla de Proximidad: Si tu carta es un ${numReal}, no puedes declarar ${numDec}. ¡Debes dar un salto drástico!`);
                return; 
            }
        }

        jugador.mano.splice(idxCarta, 1);
        jugador.turnos++;

        estadoJuego.cartaEnMesa = {
            real: cartaReal,
            declarada: numeroDeclarado,
            tipoDeclarado: tipoDeclarado,
            jugadorId: jugador.id
        };

        let paso = estadoJuego.sentidoHorario ? 1 : -1;
        let acusadorIdx = (jugador.id + paso + 6) % 6;
        while (!estadoJuego.jugadores[acusadorIdx].activo) {
            acusadorIdx = (acusadorIdx + paso + 6) % 6;
        }

        io.emit('fase_acusacion', { acusadorIdx: acusadorIdx, declaracion: { por: jugador.nombre, valor: numeroDeclarado, tipo: tipoDeclarado } });
        socket.emit('tu_mano', jugador.mano);
    });

    socket.on('resolver_acusacion', (gritaMientes) => {
        let mesa = estadoJuego.cartaEnMesa;
        if (!mesa) return;
        let j = estadoJuego.jugadores[mesa.jugadorId];
        let acusadorIdx = estadoJuego.jugadores.findIndex(p => p.socketId === socket.id);
        let acusador = estadoJuego.jugadores[acusadorIdx];

        let esMentira = mesa.real.esComodin ? (mesa.tipoDeclarado !== 'comodin') : (mesa.tipoDeclarado === 'comodin' || mesa.real.numero !== parseInt(mesa.declarada));

        if (esMentira) j.mentiras++;

        let logMsg = "";

        if (!gritaMientes) {
            if (mesa.real.esComodin && mesa.tipoDeclarado !== 'comodin') {
                acusador.puntaje = truncarPuntaje(acusador.puntaje - 1.0);
                logMsg = `${j.nombre} coló un Comodín Camuflado. ${acusador.nombre} pierde 1.0 punto.`;
            } else if (!mesa.real.esComodin && mesa.tipoDeclarado === 'comodin') {
                acusador.puntaje = truncarPuntaje(acusador.puntaje - 1.0);
                logMsg = `${j.nombre} hizo un Bluff de Comodín Falso con éxito. ${acusador.nombre} pierde 1.0 punto por cobardía.`;
            } else if (mesa.real.esComodin && mesa.tipoDeclarado === 'comodin') {
                let strP = j.puntaje.toFixed(1).split('.');
                j.puntaje = parseFloat(`${strP[1]}.${strP[0]}`);
                logMsg = `¡Comodín Honesto! El puntaje de ${j.nombre} se invierte por Efecto Espejo.`;
            } else {
                logMsg = `La jugada de ${j.nombre} pasó sin desafíos.`;
            }
        } else {
            if (esMentira) {
                if (mesa.tipoDeclarado === 'comodin' || mesa.real.esComodin) {
                    j.puntaje = truncarPuntaje(j.puntaje - 1.0);
                } else {
                    let maxVal = Math.max(mesa.real.numero, parseInt(mesa.declarada));
                    j.puntaje = truncarPuntaje(j.puntaje - (maxVal / 10));
                }
                logMsg = `¡Atrapado! ${j.nombre} mentía. Se le aplica la penalización correspondiente.`;
            } else {
                if (mesa.real.esComodin) {
                    let strP = acusador.puntaje.toFixed(1).split('.');
                    acusador.puntaje = parseFloat(`${strP[1]}.${strP[0]}`);
                    logMsg = `¡Contraataque Mortal! El puntaje de ${acusador.nombre} se invierte por acusar un Comodín real.`;
                } else {
                    acusador.puntaje = truncarPuntaje(acusador.puntaje - (mesa.real.numero / 10));
                    logMsg = `¡Falso testimonio! ${j.nombre} decía la verdad. ${acusador.nombre} pierde ${mesa.real.numero/10} puntos.`;
                }
            }
        }

        estadoJuego.jugadores.forEach(p => {
            if (p.activo && p.puntaje <= 0) {
                p.activo = false;
                io.emit('log', `¡${p.nombre} ha caído en el Abismo del Cero y queda eliminado!`);
            }
        });

        estadoJuego.cartaEnMesa = null;
        io.emit('log', logMsg);
        
        let cartasEnMano = estadoJuego.jugadores.filter(p => p.activo).reduce((acc, p) => acc + p.mano.length, 0);
        if (cartasEnMano === 0) {
            evaluarGuillotina();
        } else {
            avanzarTurno();
        }
    });

    function evaluarGuillotina() {
        let vivos = estadoJuego.jugadores.filter(p => p.activo);
        if (vivos.length <= 1) {
            io.emit('log', `¡Fin de la partida! El único superviviente es el ganador.`);
            return;
        }

        let promedio = vivos.reduce((acc, p) => acc + p.puntaje, 0) / vivos.length;
        io.emit('log', `=== Guillotina del Promedio === Promedio: ${promedio.toFixed(2)}`);

        vivos.forEach(p => {
            if (p.puntaje < promedio) {
                p.activo = false;
                io.emit('log', `La Guillotina decapita a ${p.nombre} por estar bajo el promedio.`);
            }
        });

        estadoJuego.ronda++;
        estadoJuego.sentidoHorario = !estadoJuego.sentidoHorario;
        iniciarRonda();
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log('Servidor corriendo en puerto ' + PORT));
