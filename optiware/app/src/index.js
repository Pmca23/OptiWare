// Mesma imagem para os dois papéis: ROLE=central | warehouse
require(process.env.ROLE === 'central' ? './central' : './warehouse');
